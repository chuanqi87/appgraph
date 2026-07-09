/**
 * migrate MCP — the online query surface over .migration/ artifacts.
 *
 * Locks the phase-4 contract: 4 tools with valid schemas; warm-path answers
 * (order listing, unit brief with prerequisites, module facts, verify gaps);
 * and the success-shaped degradation discipline — missing artifacts and
 * unknown names return guidance text, NEVER `isError` (an early error teaches
 * the agent to abandon the server).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeEdgeId, makeNodeId } from '../../src/appgraph/schema';
import { emptyMigrationGraph, mergeInto } from '../../src/migration/types';
import { writeMigrationGraph, migrationGraphPath } from '../../src/migration/serialize';
import { getMigrationDir, getPlanDir } from '../../src/migration/paths';
import { MIGRATE_TOOLS, MigrateToolHandler, ToolResult } from '../../src/migration/mcp/tools';
import { MigrateMcpServer } from '../../src/migration/mcp/server';
import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcTransport,
  MessageHandler,
} from '../../src/mcp/transport';

// --- fixtures ----------------------------------------------------------------

let warmRoot: string;
let coldRoot: string;

const M_CORE = makeNodeId('android', 'ArchModule', 'module:core');
const M_APP = makeNodeId('android', 'ArchModule', 'module:app');

function moduleBrief(moduleId: string, moduleName: string) {
  return {
    moduleId,
    moduleName,
    publicInterface: [],
    capabilities: [],
    dependencies: [],
    impliedDependencies: [],
    screens: [],
    dataModels: [],
    permissionCapabilities: [],
    backgroundComponents: [],
    appEntries: [],
    deeplinks: [],
  };
}

beforeAll(() => {
  coldRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-mcp-cold-'));
  warmRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-mcp-warm-'));

  // Graph: :app depends on :core; :core owns a screen navigating to another.
  const graph = emptyMigrationGraph({
    platform: 'android',
    app: { name: 'toy', packageName: 'com.toy' },
  });
  const nodes = [
    node('ArchModule', 'module:core', ':core', {
      dir: 'core',
      symbolCount: 40,
      publicInterface: ['CoreApi', 'CoreClient'],
    }),
    node('ArchModule', 'module:app', ':app', { dir: 'app', symbolCount: 200 }),
    node('Screen', 'screen:mainactivity', 'MainActivity', {}, 'activity'),
    node('Screen', 'screen:detail', 'DetailScreen', {}, 'compose'),
  ];
  const screenId = nodes[2]!.id;
  const detailId = nodes[3]!.id;
  mergeInto(graph, {
    nodes,
    edges: [
      edge('depends_on', M_APP, M_CORE, 'manifest'),
      edge('app_contains', M_CORE, screenId, 'manifest'),
      edge('navigates_to', screenId, detailId, 'lifted'),
    ],
  });
  writeMigrationGraph(migrationGraphPath(warmRoot), graph);

  const planDir = getPlanDir(warmRoot);
  fs.mkdirSync(path.join(planDir, 'units'), { recursive: true });
  fs.mkdirSync(path.join(planDir, 'contracts'), { recursive: true });
  const plan = {
    schemaVersion: 3,
    source: graph.source,
    target: graph.target,
    planning: { enabled: true, minUnitSymbols: 120, maxUnitSymbols: 3000, merged: 0, split: 0 },
    totalUnits: 2,
    appScaffold: { briefFile: 'units/00-app-scaffold.md', contractFile: 'contracts/00-app-scaffold.json' },
    units: [
      {
        id: 'u-core',
        order: 0,
        label: ':core',
        kind: 'module',
        cyclic: false,
        moduleIds: [M_CORE],
        symbolCount: 40,
        briefFile: 'units/01-core.md',
        contractFile: 'contracts/01-core.json',
        modules: [moduleBrief(M_CORE, ':core')],
      },
      {
        id: 'u-app',
        order: 1,
        label: ':app',
        kind: 'module',
        cyclic: false,
        moduleIds: [M_APP],
        symbolCount: 200,
        briefFile: 'units/02-app.md',
        contractFile: 'contracts/02-app.json',
        modules: [{ ...moduleBrief(M_APP, ':app'), dependencies: [{ moduleName: ':core', publicMembers: [] }] }],
      },
    ],
  };
  fs.writeFileSync(path.join(planDir, 'plan.json'), JSON.stringify(plan), 'utf8');
  fs.writeFileSync(path.join(planDir, 'units/01-core.md'), '# 迁移工单 1/2 · :core\n工单正文-core\n', 'utf8');
  fs.writeFileSync(path.join(planDir, 'units/02-app.md'), '# 迁移工单 2/2 · :app\n工单正文-app\n', 'utf8');
  fs.writeFileSync(path.join(planDir, 'units/00-app-scaffold.md'), '# 迁移工单 00 · 应用装配 (app scaffold)\n全局路由表-x\n', 'utf8');
  fs.writeFileSync(
    path.join(planDir, 'contracts/01-core.json'),
    JSON.stringify({
      schemaVersion: 1, unitId: 'u-core', unitLabel: ':core',
      checks: [{ id: 'a1b2c3d4', tier: 'L1', kind: 'interface', moduleId: M_CORE, moduleName: ':core', subject: 'CoreApi', expect: '', verify: 'auto' }],
    }),
    'utf8'
  );
  // Ledger: :core migrated to entry (renamed CoreClient→CorePage); :app still pending.
  fs.writeFileSync(
    path.join(getMigrationDir(warmRoot), 'ledger.json'),
    JSON.stringify({
      schemaVersion: 1,
      units: {
        'u-core': { status: 'migrated', targetModule: 'entry', targetPaths: ['entry/src'], exportMap: { CoreClient: 'CorePage' }, updatedAt: '2026-01-01T00:00:00Z' },
      },
    }),
    'utf8'
  );
  // A per-unit verify report for :core with one real gap.
  fs.mkdirSync(path.join(getMigrationDir(warmRoot), 'verify', 'units'), { recursive: true });
  fs.writeFileSync(
    path.join(getMigrationDir(warmRoot), 'verify', 'units', 'u-core.json'),
    JSON.stringify({
      schemaVersion: 1, unitId: 'u-core', unitLabel: ':core', method: 'codegraph', scope: 'ledger-paths',
      checks: [{ id: 'a1b2c3d4', tier: 'L1', kind: 'interface', moduleName: ':core', subject: 'CoreClient', status: 'fail', gapClass: 'unit-missing', evidence: ['CoreClient'] }],
      summary: { total: 1, pass: 0, fail: 1, skipped: 0, info: 0 },
    }),
    'utf8'
  );

  fs.writeFileSync(
    path.join(getMigrationDir(warmRoot), 'verify-report.json'),
    JSON.stringify({
      method: 'codegraph',
      report: {
        capabilityCoverage: 0.5,
        capabilities: { matched: ['network'], missingInTarget: ['camera'], extraInTarget: [] },
        gaps: [{ id: 'camera', severity: 'high', detail: '目标未引用 camera 能力' }],
      },
      fidelity: [
        { moduleName: ':core', sourceCount: 2, matchedCount: 1, missing: ['CoreClient'], scope: 'global' },
      ],
      screenDiff: { sourceCount: 2, targetCount: 0, missingInTarget: ['MainActivity', 'DetailScreen'] },
      entityDiff: { models: [{ name: 'Topic', present: false }], modelsMissing: 1, fieldsMissing: 0 },
    }),
    'utf8'
  );
});

afterAll(() => {
  fs.rmSync(warmRoot, { recursive: true, force: true });
  fs.rmSync(coldRoot, { recursive: true, force: true });
});

function node(
  kind: 'ArchModule' | 'Screen',
  matchKey: string,
  name: string,
  attrs: Record<string, unknown>,
  subtype?: string
) {
  return {
    id: makeNodeId('android', kind, matchKey),
    kind,
    matchKey,
    name,
    platform: 'android' as const,
    subtype,
    provenance: 'manifest' as const,
    fidelity: 'source-project' as const,
    confidence: 1,
    attrs,
  };
}

function edge(kind: 'depends_on' | 'app_contains' | 'navigates_to', from: string, to: string, provenance: 'manifest' | 'lifted') {
  return { id: makeEdgeId(kind, from, to), kind, from, to, provenance, confidence: 1 };
}

function textOf(r: ToolResult): string {
  expect(r.isError).toBeUndefined();
  return r.content.map((c) => c.text).join('\n');
}

// --- tool handler -------------------------------------------------------------

describe('migrate MCP · tools', () => {
  it('exposes exactly the 9 tools, each with an object schema', () => {
    expect(MIGRATE_TOOLS.map((t) => t.name)).toEqual([
      'migrate_order',
      'migrate_unit',
      'migrate_module_facts',
      'migrate_verify_gaps',
      'migrate_ledger',
      'migrate_ready',
      'app_screens',
      'app_nav',
      'app_features',
    ]);
    for (const t of MIGRATE_TOOLS) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema).toMatchObject({ type: 'object' });
    }
  });

  it('app_screens / app_nav / app_features render the migration graph app layer', () => {
    const h = new MigrateToolHandler(warmRoot);
    const screens = textOf(h.execute('app_screens', {}));
    expect(screens).toMatch(/^Screen \d+ 个:/);
    const nav = textOf(h.execute('app_nav', {}));
    expect(nav).toMatch(/^navigates_to \d+ 条:/);
    const features = textOf(h.execute('app_features', {}));
    expect(features).toMatch(/^Feature \d+ 个:/);
  });

  it('migrate_order lists units bottom-up with planning params', () => {
    const h = new MigrateToolHandler(warmRoot);
    const out = textOf(h.execute('migrate_order', {}));
    expect(out).toContain('共 2 个');
    expect(out).toContain('1. :core');
    expect(out).toContain('2. :app');
    expect(out).toContain('units/01-core.md');
    expect(out).toContain('120–3000');
  });

  it('migrate_unit resolves by order number, label and module name; includes brief + neighbors + gaps', () => {
    const h = new MigrateToolHandler(warmRoot);
    for (const key of ['1', ':core', 'core']) {
      const out = textOf(h.execute('migrate_unit', { unit: key }));
      expect(out, `resolve by ${key}`).toContain('单元 1/2 · :core');
      expect(out).toContain('工单正文-core');
    }
    const core = textOf(h.execute('migrate_unit', { unit: ':core' }));
    expect(core).toContain('前置单元:无');
    expect(core).toContain('后继单元(依赖本单元):2. :app');
    expect(core).toContain('CoreClient'); // verify fidelity gap for :core surfaces

    const app = textOf(h.execute('migrate_unit', { unit: ':app' }));
    expect(app).toContain('前置单元(应已完成):1. :core');
  });

  it('migrate_module_facts renders screens/nav, interface baseline and deps', () => {
    const h = new MigrateToolHandler(warmRoot);
    const out = textOf(h.execute('migrate_module_facts', { module: ':core' }));
    expect(out).toContain('# 模块 :core');
    expect(out).toContain('MainActivity(activity)');
    expect(out).toContain('导航至 DetailScreen');
    expect(out).toContain('公共接口(T3 验收基线,2 个成员)');
    expect(out).toContain('- CoreApi');

    const app = textOf(h.execute('migrate_module_facts', { module: 'app' }));
    expect(app).toContain('## 声明依赖(1)');
    expect(app).toContain('- :core');
  });

  it('migrate_verify_gaps summarizes coverage/T3/V1/V2 and filters by module', () => {
    const h = new MigrateToolHandler(warmRoot);
    const out = textOf(h.execute('migrate_verify_gaps', {}));
    expect(out).toContain('能力覆盖 50%');
    expect(out).toContain('[high] camera');
    expect(out).toContain(':core(scope=global)缺 1/2:CoreClient');
    expect(out).toContain('V1 · 目标缺失屏幕(2)');
    expect(out).toContain('V2 · 实体 schema 缺口(1 个模型)');

    const scoped = textOf(h.execute('migrate_verify_gaps', { module: ':core' }));
    expect(scoped).toContain('CoreClient');
    expect(scoped).not.toContain('V1 ·'); // module scope skips the global sections
  });

  it('degrades success-shaped: missing artifacts and unknown names return guidance, never isError', () => {
    const cold = new MigrateToolHandler(coldRoot);
    expect(textOf(cold.execute('migrate_order', {}))).toContain('迁移图未生成');
    expect(textOf(cold.execute('migrate_unit', { unit: '1' }))).toContain('迁移图未生成');
    expect(textOf(cold.execute('migrate_module_facts', { module: ':x' }))).toContain('迁移图未生成');
    expect(textOf(cold.execute('migrate_verify_gaps', {}))).toContain('验收报告未生成');

    const warm = new MigrateToolHandler(warmRoot);
    const unknownUnit = textOf(warm.execute('migrate_unit', { unit: ':nope' }));
    expect(unknownUnit).toContain('未找到单元');
    expect(unknownUnit).toContain('1. :core'); // candidates offered
    const unknownModule = textOf(warm.execute('migrate_module_facts', { module: ':nope' }));
    expect(unknownModule).toContain('相近的模块');
  });

  it('migrate_unit surfaces ledger status + dependency renames + contract summary', () => {
    const h = new MigrateToolHandler(warmRoot);
    // :core is migrated → its own status shows.
    const core = textOf(h.execute('migrate_unit', { unit: ':core' }));
    expect(core).toContain('台账状态:migrated → entry');
    expect(core).toContain('验收契约:1 check');
    expect(core).toContain('最近 verify --unit:失败 1');
    // :app depends on :core → sees where :core landed + its export rename.
    const app = textOf(h.execute('migrate_unit', { unit: ':app' }));
    expect(app).toContain('台账状态:pending(未登记)');
    expect(app).toContain('依赖去向::core → entry');
    expect(app).toContain('CoreClient→CorePage');
  });

  it('migrate_unit "scaffold" returns the app-scaffold work order', () => {
    const h = new MigrateToolHandler(warmRoot);
    for (const key of ['0', 'scaffold']) {
      const out = textOf(h.execute('migrate_unit', { unit: key }));
      expect(out, `scaffold via ${key}`).toContain('应用装配 (app scaffold)');
    }
  });

  it('migrate_verify_gaps unit mode groups by gap class from the unit report', () => {
    const h = new MigrateToolHandler(warmRoot);
    const out = textOf(h.execute('migrate_verify_gaps', { unit: '1' }));
    expect(out).toContain('单元验收缺口 · :core');
    expect(out).toContain('真实缺口 unit-missing(1)');
    expect(out).toContain('interface CoreClient');
    // A unit with no report → success-shaped hint, not an error.
    const app = textOf(h.execute('migrate_verify_gaps', { unit: ':app' }));
    expect(app).toContain('尚无单元验收报告');
  });

  it('migrate_ledger lists the table and single-unit detail; empty ledger is success-shaped', () => {
    const h = new MigrateToolHandler(warmRoot);
    const table = textOf(h.execute('migrate_ledger', {}));
    expect(table).toContain(':core: migrated → entry');
    expect(table).toContain(':app: pending(未登记)');
    const one = textOf(h.execute('migrate_ledger', { unit: ':core' }));
    expect(one).toContain('目标模块:entry');
    expect(one).toContain('导出改名:CoreClient→CorePage');
    // Cold project: no ledger yet → guidance, never isError.
    const cold = new MigrateToolHandler(coldRoot);
    expect(textOf(cold.execute('migrate_ledger', {}))).toContain('台账为空');
  });
});

// --- server routing -------------------------------------------------------------

class FakeTransport implements JsonRpcTransport {
  handler: MessageHandler | null = null;
  results = new Map<string | number, unknown>();
  errors = new Map<string | number, { code: number; message: string }>();

  start(handler: MessageHandler): void {
    this.handler = handler;
  }
  stop(): void {}
  send(_response: JsonRpcResponse): void {}
  notify(): void {}
  request(): Promise<unknown> {
    return Promise.reject(new Error('not supported'));
  }
  sendResult(id: string | number, result: unknown): void {
    this.results.set(id, result);
  }
  sendError(id: string | number | null, code: number, message: string): void {
    if (id !== null) this.errors.set(id, { code, message });
  }
  async emit(message: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    await this.handler!(message);
  }
}

describe('migrate MCP · server routing', () => {
  it('answers initialize/tools/list/tools/call/ping and rejects unknown methods', async () => {
    const t = new FakeTransport();
    new MigrateMcpServer(warmRoot, t).start();

    await t.emit({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    const init = t.results.get(1) as Record<string, unknown>;
    expect(init.protocolVersion).toBe('2025-03-26');
    expect((init.serverInfo as Record<string, unknown>).name).toBe('migrate');
    expect(String(init.instructions)).toContain('migrate_order');

    // notifications get no reply and don't crash.
    await t.emit({ jsonrpc: '2.0', method: 'notifications/initialized' });

    await t.emit({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (t.results.get(2) as { tools: Array<{ name: string }> }).tools;
    expect(tools).toHaveLength(9);

    await t.emit({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'migrate_order', arguments: {} },
    });
    const call = t.results.get(3) as ToolResult;
    expect(call.content[0]!.text).toContain(':core');

    await t.emit({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } });
    expect(t.errors.get(4)!.message).toContain('未知工具');

    await t.emit({ jsonrpc: '2.0', id: 5, method: 'ping' });
    expect(t.results.get(5)).toEqual({});

    await t.emit({ jsonrpc: '2.0', id: 6, method: 'wat' });
    expect(t.errors.get(6)!.message).toContain('Method not found');
  });
});
