/**
 * U1–U5 · source-side semantic detect passes (node-driven).
 *
 * Each pass takes `(nodes, readCode, ctx)`, so we drive them with synthetic code
 * nodes + a canned source reader — no real codegraph index needed. Locks: role
 * classification, Compose screen + navigation recovery, entity field schema,
 * the DI object graph, and reactive-flow facts, plus the determinism contract
 * (two runs → byte-identical nodes/edges).
 */

import { describe, it, expect } from 'vitest';
import { Node, NodeKind } from '../../src/types';
import { ReadCode, DetectContext } from '../../src/appgraph/detect/shared';
import { detectRoles, aggregateRolesByModule } from '../../src/appgraph/detect/roles';
import { detectComposeScreens } from '../../src/appgraph/detect/compose';
import { detectEntities } from '../../src/appgraph/detect/entities';
import { detectDi } from '../../src/appgraph/detect/di';
import { detectFlows } from '../../src/appgraph/detect/flows';

interface Fixture {
  nodes: Node[];
  readCode: ReadCode;
  ctx: DetectContext;
}

let seq = 0;
function mkNode(kind: NodeKind, name: string, moduleDir: string, code: string, fixture: Partial<Fixture> & { store: Map<string, string>; moduleOf: Map<string, string> }): Node {
  const id = `n${seq++}`;
  const node: Node = {
    id,
    kind,
    name,
    qualifiedName: `${moduleDir}/${name}.kt::${name}`,
    filePath: `${moduleDir}/src/main/kotlin/${name}.kt`,
    language: 'kotlin',
    startLine: 1,
    endLine: 1 + code.split('\n').length,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 0,
  };
  fixture.store.set(id, code);
  fixture.moduleOf.set(id, `mod:${moduleDir}`);
  return node;
}

function buildFixture(specs: Array<{ kind: NodeKind; name: string; module: string; code: string }>): Fixture {
  const store = new Map<string, string>();
  const moduleOf = new Map<string, string>();
  const helper = { store, moduleOf };
  const nodes = specs.map((s) => mkNode(s.kind, s.name, s.module, s.code, helper));
  const readCode: ReadCode = (n) => store.get(n.id) ?? null;
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
  return { nodes, readCode, ctx };
}

describe('U1 · roles', () => {
  it('classifies annotation-driven roles', () => {
    const f = buildFixture([
      { kind: 'class', name: 'ForYouViewModel', module: 'feature/foryou', code: '@HiltViewModel\nclass ForYouViewModel @Inject constructor(r: Repo) : ViewModel()' },
      { kind: 'class', name: 'TopicEntity', module: 'core/database', code: '@Entity\ndata class TopicEntity(@PrimaryKey val id: String)' },
      { kind: 'class', name: 'DaosModule', module: 'core/database', code: '@Module\n@InstallIn(SingletonComponent::class)\nobject DaosModule' },
      { kind: 'class', name: 'TopicDao', module: 'core/database', code: '@Dao\ninterface TopicDao' },
      { kind: 'function', name: 'ForYouScreen', module: 'feature/foryou', code: '@Composable\nfun ForYouScreen(state: X) {}' },
    ]);
    const roles = detectRoles(f.nodes, f.readCode);
    const byName = new Map([...roles.byNodeId].map(([id, r]) => [f.nodes.find((n) => n.id === id)!.name, r.role]));
    expect(byName.get('ForYouViewModel')).toBe('viewmodel');
    expect(byName.get('TopicEntity')).toBe('entity');
    expect(byName.get('DaosModule')).toBe('di-module');
    expect(byName.get('TopicDao')).toBe('dao');
    expect(byName.get('ForYouScreen')).toBe('screen');
  });

  it('aggregates role counts per module deterministically', () => {
    const f = buildFixture([
      { kind: 'class', name: 'A', module: 'm', code: '@Entity\ndata class A(val x: Int)' },
      { kind: 'class', name: 'B', module: 'm', code: '@Entity\ndata class B(val y: Int)' },
    ]);
    const roles = detectRoles(f.nodes, f.readCode);
    const agg = aggregateRolesByModule(roles.byNodeId, f.ctx.nodeToModuleId);
    expect(agg.get('mod:m')).toEqual({ entity: 2 });
  });
});

describe('U2 · compose screens + navigation', () => {
  it('detects *Screen composables and a navigate edge, ignoring toolbars', () => {
    const f = buildFixture([
      { kind: 'function', name: 'ForYouScreen', module: 'feature/foryou', code: '@Composable\nfun ForYouScreen(onTopic: () -> Unit) { navigateToTopic() }' },
      { kind: 'function', name: 'TopicScreen', module: 'feature/topic', code: '@Composable\nfun TopicScreen(id: String) {}' },
      { kind: 'function', name: 'NiaToolbar', module: 'core/ui', code: '@Composable\nfun NiaToolbar(onBackClick: () -> Unit) {}' },
    ]);
    const res = detectComposeScreens(f.nodes, f.readCode, f.ctx);
    const names = res.screenNodes.map((n) => n.name).sort();
    expect(names).toEqual(['ForYouScreen', 'TopicScreen']); // toolbar excluded
    const navByName = res.navEdges.map((e) => {
      const from = res.screenNodes.find((n) => n.id === e.from)!.name;
      const to = res.screenNodes.find((n) => n.id === e.to)!.name;
      return `${from}->${to}`;
    });
    expect(navByName).toContain('ForYouScreen->TopicScreen');
  });
});

describe('U3 · entities + field schema', () => {
  it('extracts field schema and excludes NavKey routes', () => {
    const f = buildFixture([
      { kind: 'class', name: 'TopicEntity', module: 'core/database', code: '@Entity(tableName = "topics")\ndata class TopicEntity(@PrimaryKey val id: String, val name: String, val url: String?)' },
      { kind: 'class', name: 'ForYouNavKey', module: 'feature/foryou', code: '@Serializable\nobject ForYouNavKey : NavKey' },
      { kind: 'class', name: 'NetworkTopic', module: 'core/network', code: '@Serializable\ndata class NetworkTopic(val id: String, @SerialName("display_name") val name: String)' },
    ]);
    const res = detectEntities(f.nodes, f.readCode, f.ctx);
    const names = res.dataModelNodes.map((n) => n.name).sort();
    expect(names).toEqual(['NetworkTopic', 'TopicEntity']); // NavKey excluded
    const topic = res.dataModelNodes.find((n) => n.name === 'TopicEntity')!;
    expect(topic.subtype).toBe('entity');
    expect(topic.attrs!.tableName).toBe('topics');
    const fields = topic.attrs!.fields as Array<{ name: string; primaryKey: boolean; nullable: boolean }>;
    expect(fields.map((x) => x.name)).toEqual(['id', 'name', 'url']);
    expect(fields[0].primaryKey).toBe(true);
    expect(fields[2].nullable).toBe(true);
    const net = res.dataModelNodes.find((n) => n.name === 'NetworkTopic')!;
    const netFields = net.attrs!.fields as Array<{ name: string; mappedName?: string }>;
    expect(netFields.find((x) => x.name === 'name')!.mappedName).toBe('display_name');
  });
});

describe('U4 · DI object graph', () => {
  it('recovers providers, injection points and cross-module wiring', () => {
    const f = buildFixture([
      { kind: 'class', name: 'DaosModule', module: 'core/database', code: '@Module\n@InstallIn(SingletonComponent::class)\nobject DaosModule' },
      { kind: 'method', name: 'providesTopicDao', module: 'core/database', code: '@Provides\nfun providesTopicDao(db: NiaDatabase): TopicDao = db.topicDao()' },
      { kind: 'class', name: 'TopicDao', module: 'core/database', code: 'interface TopicDao' },
      { kind: 'class', name: 'ForYouViewModel', module: 'feature/foryou', code: '@HiltViewModel\nclass ForYouViewModel @Inject constructor(val dao: TopicDao)' },
    ]);
    const res = detectDi(f.nodes, f.readCode, f.ctx);
    const dbFacts = res.diByModule.get('mod:core/database')!;
    expect(dbFacts.modules).toContain('DaosModule');
    expect(dbFacts.provides).toContain('TopicDao');
    expect(dbFacts.scopes).toContain('SingletonComponent');
    const vmFacts = res.diByModule.get('mod:feature/foryou')!;
    expect(vmFacts.injectionPoints[0]).toMatchObject({ name: 'ForYouViewModel', injects: ['TopicDao'] });
    // feature/foryou injects TopicDao declared in core/database → a DI depends_on edge.
    const wired = res.diEdges.find((e) => e.from === 'mod:feature/foryou' && e.to === 'mod:core/database');
    expect(wired).toBeTruthy();
    expect((wired!.attrs!.diKind as string[])).toContain('injects');
  });
});

describe('U5 · reactive flows', () => {
  it('records exposed state and collect points', () => {
    const f = buildFixture([
      { kind: 'class', name: 'ForYouViewModel', module: 'feature/foryou', code: 'class ForYouViewModel {\n  val uiState: StateFlow<ForYouUiState> = x\n  val feed: Flow<List<News>> = y\n}' },
      { kind: 'function', name: 'ForYouScreen', module: 'feature/foryou', code: '@Composable\nfun ForYouScreen(vm: VM) {\n  val s by vm.uiState.collectAsState()\n}' },
    ]);
    const res = detectFlows(f.nodes, f.readCode, f.ctx);
    const facts = res.flowsByModule.get('mod:feature/foryou')!;
    expect(facts.exposedStates.map((s) => s.name).sort()).toEqual(['feed', 'uiState']);
    expect(facts.collectPoints).toBeGreaterThan(0);
  });
});

describe('determinism', () => {
  it('two runs produce identical nodes/edges', () => {
    const specs = [
      { kind: 'class' as const, name: 'TopicEntity', module: 'core/database', code: '@Entity\ndata class TopicEntity(@PrimaryKey val id: String, val name: String)' },
      { kind: 'function' as const, name: 'ForYouScreen', module: 'feature/foryou', code: '@Composable\nfun ForYouScreen(onTopic: () -> Unit) { navigateToTopic() }' },
      { kind: 'function' as const, name: 'TopicScreen', module: 'feature/topic', code: '@Composable\nfun TopicScreen(id: String) {}' },
    ];
    seq = 0;
    const a = buildFixture(specs);
    const r1 = JSON.stringify(detectComposeScreens(a.nodes, a.readCode, a.ctx).screenNodes);
    seq = 0;
    const b = buildFixture(specs);
    const r2 = JSON.stringify(detectComposeScreens(b.nodes, b.readCode, b.ctx).screenNodes);
    expect(r1).toBe(r2);
  });
});
