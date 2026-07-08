/**
 * P · assembly + brief rendering — the analysis hand-off to an external agent.
 *
 * Locks that the U-track semantics reach the WORK ORDER: role distribution,
 * screens WITH their navigation fan-out and file anchors, entity field schemas
 * (keys/nullability), DI assembly, reactive flows, permission capabilities,
 * capability→HarmonyOS target mapping, declared vs implied (lifted)
 * dependencies with provenance tags, and the acceptance checklist.
 */

import { describe, it, expect } from 'vitest';
import { emptyMigrationGraph, mergeInto, MigrationGraph, MigrationUnit } from '../../src/migration/types';
import { AppEdge, AppNode, makeEdgeId, makeNodeId } from '../../src/appgraph/schema';
import { Node } from '../../src/types';
import { ModuleBrief, assembleModuleBrief } from '../../src/migration/plan/context';
import { renderUnitBrief } from '../../src/migration/plan/brief';
import { buildAssemblyInput } from '../../src/migration/plan';
import { CodeSymbolGraph } from '../../src/appgraph/graph-reader';

function brief(over: Partial<ModuleBrief> = {}): ModuleBrief {
  return {
    moduleId: 'm',
    moduleName: ':core:database',
    role: 'core',
    layer: 'data',
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
    ...over,
  };
}

function unit(over: Partial<MigrationUnit> = {}): MigrationUnit {
  return { id: 'u1', moduleIds: ['m'], label: ':core:database', order: 2, cyclic: false, ...over };
}

describe('P · brief rendering', () => {
  it('renders entity field schema with keys, nullability and file anchors', () => {
    const md = renderUnitBrief(
      unit(),
      [
        brief({
          roleCounts: { entity: 6, dao: 5 },
          dataModels: [
            {
              name: 'TopicEntity',
              subtype: 'entity',
              tableName: 'topics',
              file: 'core/database/src/main/kotlin/TopicEntity.kt',
              fields: [
                { name: 'id', type: 'String', nullable: false, primaryKey: true, hasDefault: false },
                { name: 'url', type: 'String', nullable: true, primaryKey: false, hasDefault: false },
              ],
            },
          ],
        }),
      ],
      22
    );
    expect(md).toContain('迁移工单 3/22');
    expect(md).toContain('组件角色分布 [静态]:entity×6 · dao×5');
    expect(md).toContain('TopicEntity → RDB 表 `topics` — core/database/src/main/kotlin/TopicEntity.kt');
    expect(md).toContain('`id: String` (PRIMARY KEY, NOT NULL)');
    expect(md).toContain('`url: String` (nullable)');
  });

  it('renders screens with navigation fan-out, DI, flows and permissions', () => {
    const md = renderUnitBrief(
      unit(),
      [
        brief({
          screens: [
            {
              name: 'ForYouScreen',
              file: 'feature/foryou/ForYouScreen.kt',
              subtype: 'compose',
              navigatesTo: ['TopicScreen'],
              layouts: [],
            },
          ],
          di: {
            modules: ['DaosModule'],
            provides: ['TopicDao'],
            binds: [{ iface: 'TopicRepository', impl: 'TopicRepositoryImpl' }],
            injectionPoints: [{ name: 'ForYouViewModel', injects: ['TopicRepository'] }],
            scopes: ['SingletonComponent'],
          },
          flows: {
            exposedStates: [{ name: 'uiState', type: 'ForYouUiState', flowKind: 'StateFlow' }],
            collectPoints: 2,
          },
          permissionCapabilities: ['notification'],
        }),
      ],
      22
    );
    expect(md).toContain('ForYouScreen(compose) — feature/foryou/ForYouScreen.kt');
    expect(md).toContain('导航至:TopicScreen');
    expect(md).toContain('@Binds 绑定:`TopicRepository` ← `TopicRepositoryImpl`');
    expect(md).toContain('注入点 `ForYouViewModel`');
    expect(md).toContain('uiState: StateFlow<ForYouUiState>');
    expect(md).toContain('权限能力 [清单]:notification');
  });

  it('renders declared vs implied dependencies with provenance tags', () => {
    const md = renderUnitBrief(
      unit(),
      [
        brief({
          dependencies: [{ moduleName: ':core:model', publicMembers: ['class Topic'] }],
          impliedDependencies: [
            { moduleName: ':core:common', weight: 12, byKind: { calls: 8, references: 4 } },
          ],
        }),
      ],
      22
    );
    expect(md).toContain('声明依赖 [清单] **:core:model** — 公共成员:class Topic');
    expect(md).toContain('隐式耦合 [启发] **:core:common** — 权重 12(calls×8 · references×4)');
  });

  it('renders the acceptance checklist tied to the verify gate', () => {
    const md = renderUnitBrief(
      unit(),
      [
        brief({
          publicInterface: [
            { kind: 'class', name: 'TopicDao', qualifiedName: 'TopicDao', file: 'a.kt' },
          ],
          screens: [{ name: 'ForYouScreen', navigatesTo: [], layouts: [] }],
          dataModels: [{ name: 'TopicEntity', subtype: 'entity', fields: [] }],
          capabilities: [{ id: 'network', harmony: null, evidence: ['retrofit2.Retrofit'] }],
          backgroundComponents: [
            { name: 'SyncService', subtype: 'service', foregroundServiceType: 'dataSync' },
          ],
          deeplinks: ['myapp://open'],
        }),
      ],
      22
    );
    expect(md).toContain('## 验收清单');
    expect(md).toContain('- [ ] T3 · 公共接口:1 个公开成员在目标侧有对应导出');
    expect(md).toContain('- [ ] V1 · 屏幕:ForYouScreen 在目标侧有对应页面');
    expect(md).toContain('- [ ] V2 · 数据模型:TopicEntity 字段级对齐');
    expect(md).toContain('- [ ] 能力覆盖:network 在目标侧出现');
    expect(md).toContain('- [ ] 后台组件:SyncService 在目标侧有对应 Ability/订阅');
    expect(md).toContain('- [ ] 深链:myapp://open 已在目标 module.json5 声明');
    expect(md).toContain('migrate verify');
  });

  it('renders background components, entry points, deep links and hosted layouts (S2)', () => {
    const md = renderUnitBrief(
      unit(),
      [
        brief({
          screens: [
            {
              name: 'MainActivity',
              file: 'app/src/main/AndroidManifest.xml',
              subtype: 'activity',
              navigatesTo: ['DetailActivity'],
              layouts: ['activity_main'],
            },
          ],
          backgroundComponents: [
            {
              name: 'SyncService',
              subtype: 'service',
              exported: true,
              foregroundServiceType: 'dataSync',
              harmonyModule: 'ServiceExtensionAbility / @ohos.resourceschedule.backgroundTaskManager',
              harmonyNote: 'Service → 系统级用 ServiceExtensionAbility',
              file: 'app/src/main/AndroidManifest.xml',
            },
          ],
          appEntries: ['MainActivity'],
          deeplinks: ['myapp://open'],
        }),
      ],
      3
    );
    expect(md).toContain('### 后台组件 [清单]');
    expect(md).toContain('- SyncService(service) — exported · 前台服务(dataSync)');
    expect(md).toContain('目标:`ServiceExtensionAbility / @ohos.resourceschedule.backgroundTaskManager`');
    expect(md).toContain('### 对外入口与深链 [清单]');
    expect(md).toContain('- 启动入口:MainActivity(目标侧 EntryAbility + 首页路由)');
    expect(md).toContain('- 深链:myapp://open(目标 module.json5 需声明对应 skills/uris)');
    expect(md).toContain('关联布局 [静态]:activity_main');
  });

  it('marks cyclic units as atomic SCCs and is deterministic', () => {
    const u = unit({ cyclic: true, moduleIds: ['a', 'b'], label: ':a,:b' });
    const modules = [brief({ moduleId: 'a', moduleName: ':a' }), brief({ moduleId: 'b', moduleName: ':b' })];
    const md = renderUnitBrief(u, modules, 5);
    expect(md).toContain('依赖环(SCC)');
    expect(renderUnitBrief(u, modules, 5)).toBe(md);
  });
});

describe('P · assembly from the enriched graph', () => {
  it('assembles interface anchors, deps (declared+lifted), screens with nav, permissions', () => {
    const graph = syntheticGraph();
    const reader = stubReader([
      codeNode('n1', 'class', 'TopicDao', 'core/database/src/main/kotlin/TopicDao.kt', 'public'),
      codeNode('n2', 'class', 'Internal', 'core/database/src/main/kotlin/Internal.kt', 'private'),
      codeNode('n3', 'import', 'retrofit2.Retrofit', 'core/database/src/main/kotlin/TopicDao.kt'),
      codeNode('n4', 'class', 'Topic', 'core/model/src/main/kotlin/Topic.kt', 'public'),
    ]);

    const input = buildAssemblyInput(graph, reader);
    const b = assembleModuleBrief(id('ArchModule', 'module:coredatabase'), input);

    expect(b.moduleName).toBe(':core:database');
    // Public interface: private member excluded, file anchor kept.
    expect(b.publicInterface.map((m) => m.name)).toEqual(['TopicDao']);
    expect(b.publicInterface[0]!.file).toContain('TopicDao.kt');
    // Capability from the import FQN, with evidence.
    expect(b.capabilities.map((c) => c.id)).toContain('network');
    // Declared dep (manifest) with the dependency's public surface.
    expect(b.dependencies).toEqual([{ moduleName: ':core:model', publicMembers: ['class Topic'] }]);
    // Lifted coupling is advisory, weighted.
    expect(b.impliedDependencies).toEqual([
      { moduleName: ':core:common', weight: 7, byKind: { calls: 7 } },
    ]);
    // Screen ownership + navigation fan-out from navigates_to edges.
    expect(b.screens).toEqual([
      {
        name: 'ForYouScreen',
        file: 'feature/foryou/ForYouScreen.kt',
        subtype: 'compose',
        navigatesTo: ['TopicScreen'],
        layouts: [],
      },
    ]);
    // Permission capability via manifest uses_capability.
    expect(b.permissionCapabilities).toEqual(['notification']);
  });
});

// --- synthetic fixtures -----------------------------------------------------

function id(kind: AppNode['kind'], matchKey: string, platform: 'android' | 'harmony' = 'android'): string {
  return makeNodeId(platform, kind, matchKey);
}

function appNode(
  kind: AppNode['kind'],
  matchKey: string,
  name: string,
  attrs?: Record<string, unknown>,
  platformRef?: { file: string; symbol?: string },
  subtype?: string
): AppNode {
  return {
    id: id(kind, matchKey),
    kind,
    matchKey,
    name,
    platform: 'android',
    subtype,
    platformRef,
    provenance: 'manifest',
    fidelity: 'source-project',
    confidence: 1,
    attrs,
  };
}

function edge(
  kind: AppEdge['kind'],
  from: string,
  to: string,
  provenance: AppEdge['provenance'],
  attrs?: Record<string, unknown>
): AppEdge {
  return { id: makeEdgeId(kind, from, to), kind, from, to, provenance, confidence: 1, attrs };
}

function syntheticGraph(): MigrationGraph {
  const graph = emptyMigrationGraph({
    platform: 'android',
    app: { name: 'toy', packageName: 'com.toy' },
  });
  const mDb = appNode('ArchModule', 'module:coredatabase', ':core:database', { dir: 'core/database' });
  const mModel = appNode('ArchModule', 'module:coremodel', ':core:model', { dir: 'core/model' });
  const mCommon = appNode('ArchModule', 'module:corecommon', ':core:common', { dir: 'core/common' });
  const forYou = appNode(
    'Screen',
    'screen:android:foryou',
    'ForYouScreen',
    { framework: 'compose' },
    { file: 'feature/foryou/ForYouScreen.kt', symbol: 'ForYouScreen' },
    'compose'
  );
  const topic = appNode(
    'Screen',
    'screen:android:topic',
    'TopicScreen',
    undefined,
    { file: 'feature/topic/TopicScreen.kt', symbol: 'TopicScreen' },
    'compose'
  );
  const cap = appNode('Capability', 'capability:notification', 'notification');

  mergeInto(graph, {
    nodes: [mDb, mModel, mCommon, forYou, topic, cap],
    edges: [
      edge('depends_on', mDb.id, mModel.id, 'manifest'),
      // A pair with a declared dep folds lifted evidence into the declared
      // edge's attrs (see modules/index.ts); a standalone lifted edge only
      // exists for an UNDECLARED pair — model that shape here.
      edge('depends_on', mDb.id, mCommon.id, 'lifted', { weight: 7, byKind: { calls: 7 } }),
      edge('app_contains', mDb.id, forYou.id, 'manifest'),
      edge('navigates_to', forYou.id, topic.id, 'manifest'),
      edge('uses_capability', mDb.id, cap.id, 'manifest'),
    ],
  });
  return graph;
}

function codeNode(
  nid: string,
  kind: Node['kind'],
  name: string,
  filePath: string,
  visibility?: string
): Node {
  return {
    id: nid,
    kind,
    name,
    qualifiedName: `${filePath}::${name}`,
    filePath,
    language: 'kotlin',
    startLine: 1,
    endLine: 2,
    startColumn: 0,
    endColumn: 0,
    visibility,
  } as Node;
}

function stubReader(nodes: Node[]): CodeSymbolGraph {
  return { getAllNodes: () => nodes } as unknown as CodeSymbolGraph;
}
