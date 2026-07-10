/**
 * P · unit acceptance contract.
 *
 * Locks the contract's load-bearing invariants: the check-id formula (content
 * identity), PACK INVARIANCE (re-packing units moves a check between files but
 * never changes its id), split-unit assignment (file anchor → owning slice,
 * module-level → completion gate), byte-determinism, and the contract-driven
 * acceptance section in the brief.
 */

import { describe, it, expect } from 'vitest';
import { emptyMigrationGraph, mergeInto, MigrationGraph, MigrationUnit } from '../../src/migration/types';
import { AppNode, makeNodeId } from '../../src/appgraph/schema';
import { Node } from '../../src/types';
import { buildAssemblyInput } from '../../src/migration/plan';
import { buildUnitContracts, checkId, ContractUnitInput } from '../../src/migration/plan/contract';
import { renderUnitBrief } from '../../src/migration/plan/brief';
import { canonicalJson } from '../../src/appgraph/serialize';
import { CodeSymbolGraph } from '../../src/appgraph/graph-reader';

const NET_ID = makeNodeId('android', 'ArchModule', 'module:corenetwork');
const F_SERVICE = 'core/network/src/main/kotlin/ApiService.kt';
const F_MODEL = 'core/network/src/main/kotlin/NetworkModel.kt';
const F_CONFIG = 'core/network/src/main/kotlin/Config.kt';

function graphWithConstants(): MigrationGraph {
  const graph = emptyMigrationGraph({ platform: 'android', app: { name: 'toy', packageName: 'com.toy' } });
  const net: AppNode = {
    id: NET_ID,
    kind: 'ArchModule',
    matchKey: 'module:corenetwork',
    name: ':core:network',
    platform: 'android',
    provenance: 'lifted',
    fidelity: 'source-project',
    confidence: 1,
    attrs: {
      dir: 'core/network',
      // U7 constants live on the module node — anchored to a file no slice owns.
      constants: {
        literals: [{ name: 'BASE_URL', value: 'https://api.example.com', kind: 'url', file: F_CONFIG }],
        routes: [],
        queries: [],
        enums: [],
      },
    },
  };
  mergeInto(graph, { nodes: [net], edges: [] });
  return graph;
}

function reader(): CodeSymbolGraph {
  const nodes: Node[] = [
    codeNode('n1', 'class', 'ApiService', F_SERVICE),
    codeNode('n2', 'class', 'NetworkModel', F_MODEL),
  ];
  return { getAllNodes: () => nodes, getCode: () => null } as unknown as CodeSymbolGraph;
}

function codeNode(id: string, kind: Node['kind'], name: string, filePath: string): Node {
  return {
    id, kind, name,
    qualifiedName: `${filePath}::${name}`,
    filePath, language: 'kotlin',
    startLine: 1, endLine: 2, startColumn: 0, endColumn: 0,
    visibility: 'public',
  } as Node;
}

const fullUnit: ContractUnitInput = { id: 'u-full', order: 0, label: ':core:network', moduleIds: [NET_ID] };
const sliceA: ContractUnitInput = { id: 'u-a', order: 0, label: ':core:network#a', moduleIds: [NET_ID], files: [F_SERVICE] };
const sliceB: ContractUnitInput = { id: 'u-b', order: 1, label: ':core:network#b', moduleIds: [NET_ID], files: [F_MODEL] };

describe('checkId', () => {
  it('pins the content-derived formula', () => {
    expect(checkId('interface', 'mod1', 'com.x.Foo')).toBe('e3d563ad2939414d');
  });

  it('changes only when kind/module/subject change', () => {
    const base = checkId('interface', 'mod1', 'com.x.Foo');
    expect(checkId('screen', 'mod1', 'com.x.Foo')).not.toBe(base);
    expect(checkId('interface', 'mod2', 'com.x.Foo')).not.toBe(base);
    expect(checkId('interface', 'mod1', 'com.x.Bar')).not.toBe(base);
  });
});

describe('buildUnitContracts', () => {
  it('generates interface + constant checks from module facts', () => {
    const input = buildAssemblyInput(graphWithConstants(), reader());
    const contract = buildUnitContracts([fullUnit], input).get('u-full')!;
    const kinds = contract.checks.map((c) => c.kind).sort();
    expect(kinds).toContain('interface');
    expect(kinds).toContain('constant');
    const iface = contract.checks.filter((c) => c.kind === 'interface').map((c) => c.subject).sort();
    expect(iface).toEqual([`${F_SERVICE}::ApiService`, `${F_MODEL}::NetworkModel`]);
    const url = contract.checks.find((c) => c.kind === 'constant')!;
    expect(url.subject).toBe('BASE_URL=https://api.example.com');
    expect(url.params).toEqual({ value: 'https://api.example.com' });
  });

  it('is PACK-INVARIANT: the check-id set is identical across unit layouts', () => {
    const input = buildAssemblyInput(graphWithConstants(), reader());
    const full = buildUnitContracts([fullUnit], input);
    const split = buildUnitContracts([sliceA, sliceB], input);

    const idsFull = [...full.get('u-full')!.checks.map((c) => c.id)].sort();
    const idsSplit = [...split.get('u-a')!.checks, ...split.get('u-b')!.checks].map((c) => c.id).sort();
    expect(idsSplit).toEqual(idsFull);
  });

  it('assigns file-anchored checks to their slice, module-level to the max-order slice', () => {
    const input = buildAssemblyInput(graphWithConstants(), reader());
    const split = buildUnitContracts([sliceA, sliceB], input);
    const inA = split.get('u-a')!.checks.map((c) => c.subject);
    const inB = split.get('u-b')!.checks.map((c) => c.subject);
    // ApiService interface → slice A (owns ApiService.kt).
    expect(inA).toContain(`${F_SERVICE}::ApiService`);
    // NetworkModel interface → slice B.
    expect(inB).toContain(`${F_MODEL}::NetworkModel`);
    // The constant is anchored to Config.kt, owned by no slice → max-order slice (B).
    expect(inB).toContain('BASE_URL=https://api.example.com');
    expect(inA).not.toContain('BASE_URL=https://api.example.com');
  });

  it('is byte-identical across two runs', () => {
    const input = buildAssemblyInput(graphWithConstants(), reader());
    const a = canonicalJson([...buildUnitContracts([sliceA, sliceB], input)]);
    const b = canonicalJson([...buildUnitContracts([sliceA, sliceB], input)]);
    expect(a).toBe(b);
  });
});

describe('brief acceptance section is contract-driven', () => {
  it('renders the contract checks when a contract is supplied', () => {
    const input = buildAssemblyInput(graphWithConstants(), reader());
    const contract = buildUnitContracts([fullUnit], input).get('u-full')!;
    const unit: MigrationUnit = { id: 'u-full', moduleIds: [NET_ID], label: ':core:network', order: 0, cyclic: false };
    const md = renderUnitBrief(unit, [], 1, contract);
    expect(md).toContain('## 验收契约(机器可核对)');
    expect(md).toContain('公开成员'); // interface aggregation line
    expect(md).toContain('常量 BASE_URL'); // constant check listed
    expect(md).toContain('--unit ":core:network"');
  });

  it('falls back to the checklist when no contract is supplied', () => {
    const unit: MigrationUnit = { id: 'u', moduleIds: ['m'], label: ':m', order: 0, cyclic: false };
    const md = renderUnitBrief(unit, [], 1);
    expect(md).toContain('## 验收清单');
  });
});

// ---------------------------------------------------------------------------
// T1-4 · interface checks carry the REAL member kind (display only). `kind`
// stays 'interface' (part of the stable id); `memberKind` labels a class member
// 类 rather than lumping it under 接口. The id must not move.
// ---------------------------------------------------------------------------

const X_ID = makeNodeId('android', 'ArchModule', 'module:corex');

function moduleGraph(matchKey: string, dir: string, attrs: Record<string, unknown> = {}): MigrationGraph {
  const graph = emptyMigrationGraph({ platform: 'android', app: { name: 'toy', packageName: 'com.toy' } });
  const mod: AppNode = {
    id: makeNodeId('android', 'ArchModule', matchKey),
    kind: 'ArchModule', matchKey, name: `:${dir.replace(/\//g, ':')}`,
    platform: 'android', provenance: 'lifted', fidelity: 'source-project', confidence: 1,
    attrs: { dir, ...attrs },
  };
  mergeInto(graph, { nodes: [mod], edges: [] });
  return graph;
}

function readerOf(nodes: Node[]): CodeSymbolGraph {
  return { getAllNodes: () => nodes, getCode: () => null } as unknown as CodeSymbolGraph;
}

describe('T1-4 · contract memberKind display + id stability', () => {
  it('class/enum/function members keep kind=interface but carry the real memberKind', () => {
    const input = buildAssemblyInput(
      moduleGraph('module:corex', 'core/x'),
      readerOf([
        codeNode('c', 'class', 'Foo', 'core/x/src/main/kotlin/Foo.kt'),
        codeNode('e', 'enum', 'Color', 'core/x/src/main/kotlin/Color.kt'),
        codeNode('f', 'function', 'doThing', 'core/x/src/main/kotlin/Fn.kt'),
      ])
    );
    const contract = buildUnitContracts(
      [{ id: 'u', order: 0, label: ':core:x', moduleIds: [X_ID] }],
      input
    ).get('u')!;

    const foo = contract.checks.find((c) => c.kind === 'interface' && c.subject.endsWith('::Foo'))!;
    expect(foo.kind).toBe('interface'); // fixed — part of the id
    expect(foo.memberKind).toBe('class'); // real kind for display
    // The id is NOT affected by memberKind — still the pure (kind,module,subject) hash.
    expect(foo.id).toBe(checkId('interface', X_ID, foo.subject));

    const enumCheck = contract.checks.find((c) => c.subject.endsWith('::Color'))!;
    expect(enumCheck.memberKind).toBe('enum');
    const fnCheck = contract.checks.find((c) => c.subject.endsWith('::doThing'))!;
    expect(fnCheck.memberKind).toBe('function');
  });

  it('brief labels a class member 类 (not 接口) via the memberKind breakdown', () => {
    const input = buildAssemblyInput(
      moduleGraph('module:corex', 'core/x'),
      readerOf([
        codeNode('c', 'class', 'Foo', 'core/x/src/main/kotlin/Foo.kt'),
        codeNode('e', 'enum', 'Color', 'core/x/src/main/kotlin/Color.kt'),
        codeNode('f', 'function', 'doThing', 'core/x/src/main/kotlin/Fn.kt'),
      ])
    );
    const contract = buildUnitContracts(
      [{ id: 'u', order: 0, label: ':core:x', moduleIds: [X_ID] }],
      input
    ).get('u')!;
    const unit: MigrationUnit = { id: 'u', moduleIds: [X_ID], label: ':core:x', order: 0, cyclic: false };
    const md = renderUnitBrief(unit, [], 1, contract);
    expect(md).toContain('公共接口:3 个公开成员须有同名导出(类×1 · 枚举×1 · 函数×1;逐条见契约文件)');
    // A class member must not be rendered as「接口」in the aggregate.
    expect(md).not.toContain('接口×1');
  });
});

// ---------------------------------------------------------------------------
// T1-5c · a truncated @Query can't be a byte-exact invariant — its L3 check is
// down-graded to a non-auto `info` check + flagged for manual review.
// ---------------------------------------------------------------------------

const DB_ID = makeNodeId('android', 'ArchModule', 'module:coredb');

describe('T1-5c · truncated SQL L3 check downgrade', () => {
  it('marks a truncated @Query check verify=info, drops auto-scan, flags manual review', () => {
    const graph = moduleGraph('module:coredb', 'core/db', {
      constants: {
        literals: [],
        routes: [],
        queries: [
          { sql: 'SELECT ' + 'x, '.repeat(300) + 'y FROM big', file: 'core/db/Q.kt', truncated: true },
          { sql: 'SELECT * FROM t', file: 'core/db/Q.kt' },
        ],
        enums: [],
      },
    });
    const input = buildAssemblyInput(graph, readerOf([]));
    const contract = buildUnitContracts(
      [{ id: 'u', order: 0, label: ':core:db', moduleIds: [DB_ID] }],
      input
    ).get('u')!;

    const queries = contract.checks.filter((c) => c.kind === 'query');
    expect(queries).toHaveLength(2);
    const truncated = queries.find((c) => c.params?.truncated === true)!;
    expect(truncated.verify).toBe('info');
    expect(truncated.depth).toBeUndefined(); // no contains-scan over a clipped statement
    expect(truncated.expect).toContain('截断');
    const normal = queries.find((c) => c.params?.truncated !== true)!;
    expect(normal.verify).toBe('auto');
    expect(normal.depth).toBe('contains-scan');
  });
});
