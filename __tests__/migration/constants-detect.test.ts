/**
 * U7 · semantic-constant detect pass.
 *
 * Drives `detectConstants` with synthetic Kotlin nodes + a canned reader (no
 * codegraph index). Locks: each literal form (URL/string/number/route/SQL/enum),
 * values sliced from the ORIGINAL source (sanitization would blank them), the
 * deterministic noise-filter rules, value-dedup, and the determinism contract.
 */

import { describe, it, expect } from 'vitest';
import { Node, NodeKind } from '../../src/types';
import { ReadCode, DetectContext } from '../../src/migration/detect/shared';
import { detectConstants } from '../../src/migration/detect/constants';

interface Fixture {
  nodes: Node[];
  readCode: ReadCode;
  ctx: DetectContext;
}

let seq = 0;
function buildFixture(
  specs: Array<{ kind: NodeKind; name: string; module: string; code: string }>
): Fixture {
  const store = new Map<string, string>();
  const moduleOf = new Map<string, string>();
  const nodes = specs.map((s) => {
    const id = `n${seq++}`;
    store.set(id, s.code);
    moduleOf.set(id, `mod:${s.module}`);
    return {
      id,
      kind: s.kind,
      name: s.name,
      qualifiedName: `${s.module}/${s.name}.kt::${s.name}`,
      filePath: `${s.module}/src/main/kotlin/${s.name}.kt`,
      language: 'kotlin',
      startLine: 1,
      endLine: 1 + s.code.split('\n').length,
      startColumn: 0,
      endColumn: 0,
      updatedAt: 0,
    } as Node;
  });
  const modules = [...new Set(specs.map((s) => s.module))];
  const ctx: DetectContext = {
    nodeToModuleId: moduleOf,
    moduleNameById: new Map(modules.map((m) => [`mod:${m}`, m])),
    archModules: modules.map((m) => ({
      id: `mod:${m}`,
      kind: 'ArchModule' as const,
      matchKey: `module:${m}`,
      name: m,
      platform: 'android' as const,
      provenance: 'lifted' as const,
      fidelity: 'source-project' as const,
      confidence: 1,
      attrs: { dir: m },
    })),
  };
  return { nodes, readCode: (n) => store.get(n.id) ?? null, ctx };
}

describe('detectConstants · extraction forms', () => {
  it('recovers URLs, strings, routes, SQL and enum value sets', () => {
    const f = buildFixture([
      {
        kind: 'class',
        name: 'ApiConfig',
        module: 'core/network',
        code: 'object ApiConfig {\n  const val BASE_URL = "https://api.example.com/v1"\n  const val AUTH_HEADER = "X-Auth-Token"\n}',
      },
      {
        kind: 'method',
        name: 'getTopics',
        module: 'core/network',
        code: '@GET("/topics")\nsuspend fun getTopics(): List<NetworkTopic>',
      },
      {
        kind: 'method',
        name: 'bookmarked',
        module: 'core/database',
        code: '@Query("SELECT * FROM news WHERE is_bookmarked = 1")\nfun bookmarked(): List<News>',
      },
      {
        kind: 'enum',
        name: 'SyncState',
        module: 'core/database',
        code: 'enum class SyncState { IDLE, RUNNING, FAILED }',
      },
    ]);
    const res = detectConstants(f.nodes, f.readCode, f.ctx);

    const net = res.constantsByModule.get('mod:core/network')!;
    // Sorted by value then name: 'https://…' sorts before 'X-Auth-Token'.
    expect(net.literals).toEqual([
      { name: 'BASE_URL', value: 'https://api.example.com/v1', kind: 'url', file: 'core/network/src/main/kotlin/ApiConfig.kt' },
      { name: 'AUTH_HEADER', value: 'X-Auth-Token', kind: 'string', file: 'core/network/src/main/kotlin/ApiConfig.kt' },
    ]);
    expect(net.routes).toEqual([
      { method: 'GET', path: '/topics', file: 'core/network/src/main/kotlin/getTopics.kt' },
    ]);

    const db = res.constantsByModule.get('mod:core/database')!;
    expect(db.queries).toEqual([
      { sql: 'SELECT * FROM news WHERE is_bookmarked = 1', file: 'core/database/src/main/kotlin/bookmarked.kt' },
    ]);
    expect(db.enums).toEqual([
      { name: 'SyncState', values: ['FAILED', 'IDLE', 'RUNNING'], file: 'core/database/src/main/kotlin/SyncState.kt' },
    ]);
  });

  it('slices literal values from the original code despite `class`/`//` decoys', () => {
    const f = buildFixture([
      {
        kind: 'class',
        name: 'Msg',
        module: 'm',
        code: 'object Msg {\n  const val TEMPLATE = "class // fun object"\n}',
      },
    ]);
    const res = detectConstants(f.nodes, f.readCode, f.ctx);
    expect(res.constantsByModule.get('mod:m')!.literals[0]!.value).toBe('class // fun object');
  });
});

describe('detectConstants · noise rules', () => {
  it('drops short strings, pure-digit strings, and 0/1/-1 numbers', () => {
    const f = buildFixture([
      {
        kind: 'class',
        name: 'Noise',
        module: 'm',
        code: [
          'object Noise {',
          '  const val TINY = "ab"',            // < 4 chars → dropped
          '  const val DIGITS = "12345"',       // pure digits → dropped
          '  const val ZERO = 0',               // 0 → dropped
          '  const val ONE = 1',                // 1 → dropped
          '  const val KEEP = "meaningful_key"',
          '  const val PORT = 8080',
          '}',
        ].join('\n'),
      },
    ]);
    const res = detectConstants(f.nodes, f.readCode, f.ctx);
    const lits = res.constantsByModule.get('mod:m')!.literals;
    expect(lits.map((l) => l.name).sort()).toEqual(['KEEP', 'PORT']);
  });

  it('only treats select/insert/update/delete/with @Query as SQL', () => {
    const f = buildFixture([
      { kind: 'method', name: 'a', module: 'm', code: '@Query("SELECT 1")\nfun a(): Int' },
      { kind: 'method', name: 'b', module: 'm', code: '@Query("topics")\nfun b(): String' },
    ]);
    const res = detectConstants(f.nodes, f.readCode, f.ctx);
    expect(res.constantsByModule.get('mod:m')!.queries.map((q) => q.sql)).toEqual(['SELECT 1']);
  });
});

describe('detectConstants · dedup + determinism', () => {
  it('dedups literals by value, keeping the lexicographically smallest name', () => {
    const f = buildFixture([
      {
        kind: 'class',
        name: 'Dup',
        module: 'm',
        code: 'object Dup {\n  const val ZEBRA = "shared_value"\n  const val ALPHA = "shared_value"\n}',
      },
    ]);
    const lits = detectConstants(f.nodes, f.readCode, f.ctx).constantsByModule.get('mod:m')!.literals;
    expect(lits).toHaveLength(1);
    expect(lits[0]!.name).toBe('ALPHA');
  });

  it('two runs produce identical facts', () => {
    const specs = [
      { kind: 'class' as const, name: 'ApiConfig', module: 'core/network', code: 'object ApiConfig { const val BASE_URL = "https://x.example.com" }' },
      { kind: 'method' as const, name: 'get', module: 'core/network', code: '@GET("/a")\nfun get()' },
    ];
    seq = 0;
    const a = buildFixture(specs);
    const r1 = JSON.stringify([...detectConstants(a.nodes, a.readCode, a.ctx).constantsByModule]);
    seq = 0;
    const b = buildFixture(specs);
    const r2 = JSON.stringify([...detectConstants(b.nodes, b.readCode, b.ctx).constantsByModule]);
    expect(r1).toBe(r2);
  });
});
