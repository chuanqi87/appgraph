/**
 * P0 · parallel-scheduling structure + declared navigation coverage.
 *
 * Locks the three P0 capabilities:
 *   1. topo order persists `wave` (Kahn frontier round) and `dependsOn`
 *      (direct SCC deps as unit ids) — the scheduler's parallel structure;
 *   2. planUnits persists `wave`/`dependsOnUnitIds` on every planned unit
 *      (module deps projected + split slices chained serially), and the
 *      `migrate_ready` MCP tool answers "what can start now" from
 *      plan.json + ledger.json alone;
 *   3. nav_graph.xml destinations/actions become Screens + conf-1
 *      `navigates_to` edges (nested subgraphs + <include> resolve; broken
 *      references warn, never drop silently), and third-party navigation
 *      frameworks fingerprint into explicit blind-spot warnings.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AppEdge, AppNode, makeEdgeId, makeNodeId, screenMatchKey } from '../../src/appgraph/schema';
import { computeMigrationOrder } from '../../src/migration/order/topo';
import { emptyMigrationGraph, mergeInto, MigrationGraph } from '../../src/migration/types';
import { DEFAULT_PLANNING_OPTIONS, planUnits } from '../../src/migration/plan/unit-planning';
import { MigrateToolHandler } from '../../src/migration/mcp/tools';
import { getLedgerPath, getPlanDir } from '../../src/migration/paths';
import { detectNavigationXml } from '../../src/appgraph/detect/android-navigation-xml';
import { detectNavFrameworks } from '../../src/appgraph/detect/nav-frameworks';
import { navCoverageWarnings } from '../../src/appgraph/detect/semantics';
import { Node } from '../../src/types';

// --- shared fixture helpers ---------------------------------------------------

function archModule(name: string, symbolCount: number): AppNode {
  const matchKey = `module:${name}`;
  return {
    id: makeNodeId('android', 'ArchModule', matchKey),
    kind: 'ArchModule',
    matchKey,
    name: `:${name}`,
    platform: 'android',
    provenance: 'manifest',
    fidelity: 'source-project',
    confidence: 1,
    attrs: { dir: name, symbolCount },
  };
}

function dependsOn(from: AppNode, to: AppNode, scope?: string): AppEdge {
  return {
    id: makeEdgeId('depends_on', from.id, to.id),
    kind: 'depends_on',
    from: from.id,
    to: to.id,
    provenance: 'manifest',
    confidence: 1,
    ...(scope ? { attrs: { scope } } : {}),
  };
}

function graphOf(nodes: AppNode[], edges: AppEdge[]): MigrationGraph {
  const graph = emptyMigrationGraph({ platform: 'android', app: { name: 't', packageName: 'c.t' } });
  mergeInto(graph, { nodes, edges });
  const modules = graph.nodes.filter((n) => n.kind === 'ArchModule');
  graph.order = computeMigrationOrder(modules, graph.edges).order;
  return graph;
}

// =============================================================================
// 1 · topo order: wave + dependsOn
// =============================================================================

describe('computeMigrationOrder — persisted wave + dependsOn', () => {
  // Diamond: app → {feat1, feat2} → core. Waves: core=0, feat1/feat2=1, app=2.
  const core = archModule('core', 100);
  const feat1 = archModule('feat1', 100);
  const feat2 = archModule('feat2', 100);
  const app = archModule('app', 100);
  const edges = [
    dependsOn(app, feat1),
    dependsOn(app, feat2),
    dependsOn(feat1, core),
    dependsOn(feat2, core),
  ];

  it('assigns Kahn frontier rounds as waves and direct SCC deps as unit ids', () => {
    const { order } = computeMigrationOrder([core, feat1, feat2, app], edges);
    const byLabel = new Map(order.units.map((u) => [u.label, u]));

    expect(byLabel.get(':core')!.wave).toBe(0);
    expect(byLabel.get(':feat1')!.wave).toBe(1);
    expect(byLabel.get(':feat2')!.wave).toBe(1);
    expect(byLabel.get(':app')!.wave).toBe(2);

    expect(byLabel.get(':core')!.dependsOn).toEqual([]);
    expect(byLabel.get(':feat1')!.dependsOn).toEqual([byLabel.get(':core')!.id]);
    expect(byLabel.get(':app')!.dependsOn!.sort()).toEqual(
      [byLabel.get(':feat1')!.id, byLabel.get(':feat2')!.id].sort()
    );
  });

  it('is deterministic across runs', () => {
    const a = computeMigrationOrder([core, feat1, feat2, app], edges);
    const b = computeMigrationOrder([core, feat1, feat2, app], edges);
    expect(JSON.stringify(a.order)).toBe(JSON.stringify(b.order));
  });

  it('test-scoped deps do not create waves/deps', () => {
    const testing = archModule('testing', 50);
    const { order } = computeMigrationOrder(
      [core, testing],
      [dependsOn(core, testing, 'test')]
    );
    const coreUnit = order.units.find((u) => u.label === ':core')!;
    expect(coreUnit.wave).toBe(0);
    expect(coreUnit.dependsOn).toEqual([]);
  });
});

// =============================================================================
// 2 · planUnits: dependsOnUnitIds + wave (module deps + split chaining)
// =============================================================================

describe('planUnits — persisted unit dependencies', () => {
  it('projects module deps onto planned units and computes waves', () => {
    const core = archModule('core', 500);
    const feat = archModule('feat', 500);
    const app = archModule('app', 500);
    const graph = graphOf([core, feat, app], [dependsOn(app, feat), dependsOn(feat, core)]);

    const { units } = planUnits(graph.order!, graph, DEFAULT_PLANNING_OPTIONS, new Map(), new Map());
    const byLabel = new Map(units.map((u) => [u.label, u]));

    expect(byLabel.get(':core')!.dependsOnUnitIds).toEqual([]);
    expect(byLabel.get(':core')!.wave).toBe(0);
    expect(byLabel.get(':feat')!.dependsOnUnitIds).toEqual([byLabel.get(':core')!.id]);
    expect(byLabel.get(':feat')!.wave).toBe(1);
    expect(byLabel.get(':app')!.dependsOnUnitIds).toEqual([byLabel.get(':feat')!.id]);
    expect(byLabel.get(':app')!.wave).toBe(2);
  });

  const subFeature = (bigId: string, name: string, sig: string, members: string[]): AppNode => ({
    id: makeNodeId('android', 'Feature', `feature:${sig}`),
    kind: 'Feature',
    matchKey: `feature:${sig}`,
    name,
    platform: 'android',
    subtype: 'subdivision',
    provenance: 'lifted',
    fidelity: 'source-project',
    confidence: 0.7,
    attrs: { sig, moduleSpan: [bigId], members, size: members.length },
  });
  const featureDep = (from: AppNode, to: AppNode): AppEdge => ({
    id: makeEdgeId('depends_on', from.id, to.id),
    kind: 'depends_on',
    from: from.id,
    to: to.id,
    provenance: 'lifted',
    confidence: 0.7,
    attrs: { scope: 'feature' },
  });

  it('keeps independent split slices in one wave; the rest glue depends on all of them', () => {
    const big = archModule('big', 8000);
    const a = subFeature(big.id, 'A', 'siga', ['big/a.kt']);
    const b = subFeature(big.id, 'B', 'sigb', ['big/b.kt']);
    // A and B carry NO Feature→Feature edge — they are independent.
    const graph = graphOf([big], []);
    mergeInto(graph, { nodes: [a, b] });

    const files = new Map([[big.id, ['big/a.kt', 'big/b.kt', 'big/rest.kt']]]);
    const counts = new Map([
      ['big/a.kt', 4000],
      ['big/b.kt', 3000],
      ['big/rest.kt', 1000],
    ]);
    const { units } = planUnits(graph.order!, graph, DEFAULT_PLANNING_OPTIONS, files, counts);

    expect(units.length).toBe(3); // two feature slices + rest
    const [uA, uB, rest] = units;
    // Independent features share wave 0 (parallel), neither depends on the other.
    expect(uA!.dependsOnUnitIds).toEqual([]);
    expect(uA!.wave).toBe(0);
    expect(uB!.dependsOnUnitIds).toEqual([]);
    expect(uB!.wave).toBe(0);
    // The rest glue depends on BOTH feature slices and sits one wave later.
    expect(rest!.featureSig).toBe('rest');
    expect(rest!.dependsOnUnitIds.sort()).toEqual([uA!.id, uB!.id].sort());
    expect(rest!.wave).toBe(1);
  });

  it('serializes split slices along a real Feature→Feature dependency', () => {
    const big = archModule('big', 8000);
    const a = subFeature(big.id, 'A', 'siga', ['big/a.kt']);
    const b = subFeature(big.id, 'B', 'sigb', ['big/b.kt']);
    // B depends on A (real Feature edge) → A migrates first, B after.
    const graph = graphOf([big], []);
    mergeInto(graph, { nodes: [a, b], edges: [featureDep(b, a)] });

    const files = new Map([[big.id, ['big/a.kt', 'big/b.kt', 'big/rest.kt']]]);
    const counts = new Map([
      ['big/a.kt', 4000],
      ['big/b.kt', 3000],
      ['big/rest.kt', 1000],
    ]);
    const { units } = planUnits(graph.order!, graph, DEFAULT_PLANNING_OPTIONS, files, counts);
    const byLabel = new Map(units.map((u) => [u.label, u]));
    const uA = byLabel.get(':big#A')!;
    const uB = byLabel.get(':big#B')!;
    const rest = byLabel.get(':big#rest')!;

    expect(uA.dependsOnUnitIds).toEqual([]);
    expect(uA.wave).toBe(0);
    expect(uB.dependsOnUnitIds).toEqual([uA.id]);
    expect(uB.wave).toBe(1);
    expect(rest.dependsOnUnitIds.sort()).toEqual([uA.id, uB.id].sort());
    expect(rest.wave).toBe(2);
  });

  it('re-splits an oversized rest remainder by source directory', () => {
    const big = archModule('big', 12000);
    const a = subFeature(big.id, 'A', 'siga', ['big/src/main/java/app/feat/Screen.kt']);
    const graph = graphOf([big], []);
    mergeInto(graph, { nodes: [a] });

    // rest = everything except the one covered feature file; ~8000 symbols across
    // two package directories → over max(3000), so it splits by directory.
    const files = new Map([
      [
        big.id,
        [
          'big/src/main/java/app/feat/Screen.kt',
          'big/src/main/java/app/data/Repo.kt',
          'big/src/main/java/app/data/Dao.kt',
          'big/src/main/java/app/ui/View.kt',
          'big/src/main/java/app/ui/Adapter.kt',
        ],
      ],
    ]);
    const counts = new Map([
      ['big/src/main/java/app/feat/Screen.kt', 4000],
      ['big/src/main/java/app/data/Repo.kt', 1000],
      ['big/src/main/java/app/data/Dao.kt', 1000],
      ['big/src/main/java/app/ui/View.kt', 1000],
      ['big/src/main/java/app/ui/Adapter.kt', 1000],
    ]);
    const { units } = planUnits(graph.order!, graph, DEFAULT_PLANNING_OPTIONS, files, counts);

    const restUnits = units.filter((u) => u.featureSig !== 'siga');
    // Two package directories (app.data, app.ui) → two rest slices, not one monolith.
    expect(restUnits.length).toBe(2);
    expect(restUnits.every((u) => u.kind === 'split')).toBe(true);
    expect(restUnits.map((u) => u.label).sort()).toEqual([':big#rest/app.data', ':big#rest/app.ui']);
    expect(restUnits.every((u) => u.symbolCount <= DEFAULT_PLANNING_OPTIONS.maxUnitSymbols)).toBe(true);
    // Each rest slice's files all sit under its own directory.
    for (const u of restUnits) {
      const dirs = new Set(u.files!.map((f) => f.slice(0, f.lastIndexOf('/'))));
      expect(dirs.size).toBe(1);
    }
    // Rest slices are independent of each other (parallel), and each depends on
    // the feature slice (glue after features).
    const featUnit = units.find((u) => u.featureSig === 'siga')!;
    for (const u of restUnits) {
      expect(u.dependsOnUnitIds).toEqual([featUnit.id]);
    }
  });
});

// =============================================================================
// 3 · migrate_ready — readiness from plan.json + ledger.json
// =============================================================================

describe('migrate_ready', () => {
  let root: string;
  let handler: MigrateToolHandler;
  let unitIds: Map<string, string>; // label → unit id

  const call = (): string => {
    const r = handler.execute('migrate_ready', {});
    expect(r.isError).toBeUndefined();
    return r.content[0]!.text;
  };
  const setStatus = (label: string, status: string): void => {
    const ledgerPath = getLedgerPath(root);
    const ledger = fs.existsSync(ledgerPath)
      ? JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))
      : { schemaVersion: 1, units: {} };
    ledger.units[unitIds.get(label)!] = { status, updatedAt: '2026-01-01T00:00:00.000Z' };
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
  };

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-ready-'));
    handler = new MigrateToolHandler(root);

    // Diamond plan: :core ← {:feat1,:feat2} ← :app, waves 0/1/1/2.
    const core = archModule('core', 500);
    const feat1 = archModule('feat1', 500);
    const feat2 = archModule('feat2', 500);
    const app = archModule('app', 500);
    const graph = graphOf(
      [core, feat1, feat2, app],
      [dependsOn(app, feat1), dependsOn(app, feat2), dependsOn(feat1, core), dependsOn(feat2, core)]
    );
    const { units } = planUnits(graph.order!, graph, DEFAULT_PLANNING_OPTIONS, new Map(), new Map());
    unitIds = new Map(units.map((u) => [u.label, u.id]));

    const planDir = getPlanDir(root);
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(
      path.join(planDir, 'plan.json'),
      JSON.stringify({
        schemaVersion: 4,
        source: graph.source,
        target: graph.target,
        planning: { enabled: true, minUnitSymbols: 120, maxUnitSymbols: 3000, merged: 0, split: 0 },
        totalUnits: units.length,
        units: units.map((u) => ({ ...u, briefFile: `units/u.md`, contractFile: `contracts/u.json`, modules: [] })),
        appScaffold: { briefFile: 'units/00-app-scaffold.md', contractFile: 'contracts/00-app-scaffold.json' },
      })
    );
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('with an empty ledger, only wave-0 units are ready', () => {
    const out = call();
    expect(out).toContain(':core');
    expect(out).toContain('波次 0');
    expect(out).not.toMatch(/波次 1/);
    expect(out).toContain('0/4');
  });

  it('completing a unit unlocks exactly its dependents, in-progress units are listed apart', () => {
    setStatus(':core', 'migrated');
    let out = call();
    expect(out).toContain(':feat1');
    expect(out).toContain(':feat2');
    expect(out).not.toMatch(/^\s*\d+\. :app/m); // app's deps not done yet

    setStatus(':feat1', 'in-progress');
    out = call();
    expect(out).toContain('进行中(1)');
    expect(out).toContain(':feat2'); // still ready
  });

  it('all units done reports completion', () => {
    for (const label of [':feat1', ':feat2', ':app']) setStatus(label, 'migrated');
    const out = call();
    expect(out).toContain('4/4');
    expect(out).toContain('全部单元已迁移完成');
  });

  it('a v3 plan (no persisted deps) gets a re-plan guidance, not an error', () => {
    const oldRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-ready-v3-'));
    try {
      const planDir = getPlanDir(oldRoot);
      fs.mkdirSync(planDir, { recursive: true });
      fs.writeFileSync(
        path.join(planDir, 'plan.json'),
        JSON.stringify({
          schemaVersion: 3,
          planning: { enabled: true },
          totalUnits: 1,
          units: [{ id: 'x', order: 0, label: ':a', kind: 'module', cyclic: false, moduleIds: ['m'], symbolCount: 1 }],
        })
      );
      const r = new MigrateToolHandler(oldRoot).execute('migrate_ready', {});
      expect(r.isError).toBeUndefined();
      expect(r.content[0]!.text).toContain('migrate plan');
    } finally {
      fs.rmSync(oldRoot, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// 4 · nav_graph.xml → Screens + conf-1 navigates_to
// =============================================================================

describe('detectNavigationXml', () => {
  let root: string;

  const write = (rel: string, content: string): void => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-xml-'));
    write(
      'app/src/main/res/navigation/nav_main.xml',
      `<?xml version="1.0" encoding="utf-8"?>
<navigation xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:app="http://schemas.android.com/apk/res-auto"
    android:id="@+id/nav_main"
    app:startDestination="@id/home">
  <fragment android:id="@+id/home" android:name="com.toy.HomeFragment">
    <action android:id="@+id/to_detail" app:destination="@id/detail"/>
    <action android:id="@+id/to_settings" app:destination="@id/nav_settings"/>
    <action android:id="@+id/to_player" app:destination="@id/player_graph"/>
    <action android:id="@+id/to_nowhere" app:destination="@id/does_not_exist"/>
  </fragment>
  <dialog android:id="@+id/detail" android:name="com.toy.DetailDialog"/>
  <activity android:id="@+id/about" android:name="com.toy.AboutActivity"/>
  <navigation android:id="@+id/player_graph" app:startDestination="@id/player">
    <fragment android:id="@+id/player" android:name="com.toy.PlayerFragment">
      <action android:id="@+id/player_to_about" app:destination="@id/about"/>
    </fragment>
  </navigation>
  <include app:graph="@navigation/nav_settings"/>
  <action android:id="@+id/global_home" app:destination="@id/home"/>
</navigation>`
    );
    write(
      'app/src/main/res/navigation/nav_settings.xml',
      `<navigation xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:app="http://schemas.android.com/apk/res-auto"
    android:id="@+id/nav_settings"
    app:startDestination="@id/settings">
  <fragment android:id="@+id/settings" android:name="com.toy.SettingsFragment"/>
</navigation>`
    );
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const modules = [{ id: 'mod-app', name: ':app', dir: 'app' }];

  it('emits conf-1 navigates_to across direct, subgraph and include targets', () => {
    const result = detectNavigationXml(root, modules, []);
    const nav = result.edges.filter((e) => e.kind === 'navigates_to');
    const names = new Map(result.screenNodes.map((n) => [n.id, n.name]));
    const pairs = nav.map((e) => `${names.get(e.from)}→${names.get(e.to)}`).sort();

    expect(pairs).toEqual([
      'HomeFragment→DetailDialog', // direct action
      'HomeFragment→PlayerFragment', // action to nested subgraph → its startDestination
      'HomeFragment→SettingsFragment', // action to included graph root → its startDestination
      'PlayerFragment→AboutActivity', // action inside the nested subgraph
    ]);
    for (const e of nav) {
      expect(e.confidence).toBe(1);
      expect(e.provenance).toBe('manifest');
      expect(e.attrs?.via).toBe('nav-graph-xml');
    }
  });

  it('registers destinations as Screens with the right subtype + module attribution', () => {
    const result = detectNavigationXml(root, modules, []);
    const byName = new Map(result.screenNodes.map((n) => [n.name, n]));
    expect(byName.get('HomeFragment')!.subtype).toBe('fragment');
    expect(byName.get('DetailDialog')!.subtype).toBe('dialog');
    expect(byName.get('AboutActivity')!.subtype).toBe('activity');
    expect(byName.get('HomeFragment')!.attrs?.module).toBe(':app');
    expect(byName.get('HomeFragment')!.confidence).toBe(1);
    // Contained by the owning module.
    const contains = result.edges.filter((e) => e.kind === 'app_contains');
    expect(contains.some((e) => e.from === 'mod-app' && e.to === byName.get('HomeFragment')!.id)).toBe(true);
  });

  it('reuses an existing Screen by simple name instead of duplicating', () => {
    const existing: AppNode = {
      id: makeNodeId('android', 'Screen', screenMatchKey('AboutActivity')),
      kind: 'Screen',
      matchKey: screenMatchKey('AboutActivity'),
      name: 'AboutActivity',
      platform: 'android',
      subtype: 'activity',
      provenance: 'manifest',
      fidelity: 'source-project',
      confidence: 1,
    };
    const result = detectNavigationXml(root, modules, [existing]);
    expect(result.screenNodes.some((n) => n.name === 'AboutActivity')).toBe(false);
    const nav = result.edges.filter((e) => e.kind === 'navigates_to');
    expect(nav.some((e) => e.to === existing.id)).toBe(true);
  });

  it('warns on unresolvable destinations and unattributable global actions', () => {
    const result = detectNavigationXml(root, modules, []);
    expect(result.warnings.some((w) => w.message.includes('does_not_exist'))).toBe(true);
    expect(result.warnings.some((w) => w.message.includes('全局'))).toBe(true);
  });

  it('is deterministic', () => {
    const a = detectNavigationXml(root, modules, []);
    const b = detectNavigationXml(root, modules, []);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// =============================================================================
// 5 · third-party navigation-framework fingerprints
// =============================================================================

describe('detectNavFrameworks', () => {
  const importNode = (name: string): Node =>
    ({
      id: `imp-${name}`,
      kind: 'import',
      name,
      filePath: 'app/src/main/kotlin/App.kt',
      startLine: 1,
      endLine: 1,
    }) as unknown as Node;

  it('fingerprints an UNCOVERED framework (Conductor) with an explicit blind-spot warning', () => {
    const { frameworks, warnings } = detectNavFrameworks([
      importNode('com.bluelinelabs.conductor.Controller'),
      importNode('kotlinx.coroutines.flow.Flow'),
    ]);
    expect(frameworks).toEqual(['Conductor']);
    expect(warnings.length).toBe(1);
    expect(warnings[0]!.message).toContain('Conductor');
    expect(warnings[0]!.message).toContain('不完整');
  });

  it('does NOT flag Circuit — it is statically covered (detectCircuitScreens + circuit-nav)', () => {
    const { frameworks, warnings } = detectNavFrameworks([
      importNode('com.slack.circuit.runtime.screen.Screen'),
      importNode('com.slack.circuit.foundation.Circuit'),
    ]);
    expect(frameworks).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('stays silent when no framework import is present', () => {
    const { frameworks, warnings } = detectNavFrameworks([importNode('androidx.navigation.NavController')]);
    expect(frameworks).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

// =============================================================================
// 6 · nav-coverage anti-silence guards (empty / sparse / Screen under-detection)
// =============================================================================

describe('navCoverageWarnings', () => {
  const base = { screenCount: 0, totalNavEdges: 0, activityScreens: 0, appEntries: 0 };
  const msgs = (
    c: Partial<typeof base>,
    synth = 0
  ): string[] => navCoverageWarnings({ ...base, ...c }, () => synth).map((w) => w.message);

  it('empty-nav: screens but zero edges + no synth edges → re-index/uncovered guidance', () => {
    const out = msgs({ screenCount: 8, totalNavEdges: 0 }, 0);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('没有任何 compose-route/android-intent 合成边');
  });

  it('empty-nav with synth edges present → "none attributed" variant (reads getSynthCount)', () => {
    const out = msgs({ screenCount: 8, totalNavEdges: 0 }, 5);
    expect(out[0]).toContain('5 条导航合成边');
  });

  it('sparse-nav: ≥20 screens with <5% edges warns; does not fire below the floor', () => {
    expect(msgs({ screenCount: 30, totalNavEdges: 1 })).toEqual([
      expect.stringContaining('导航覆盖异常稀疏'),
    ]);
    expect(msgs({ screenCount: 8, totalNavEdges: 1 })).toEqual([]); // 5≤screens<20, has an edge
  });

  it('Screen under-detection: launcher + Activity but no richer screen → warns', () => {
    // 1 manifest Activity == screenCount (richScreens 0), 1 launcher entry.
    const out = msgs({ screenCount: 1, activityScreens: 1, appEntries: 1, totalNavEdges: 0 });
    expect(out.some((m) => m.includes('未识别出任何 Compose/布局/Fragment 屏幕'))).toBe(true);
  });

  it('Screen under-detection stays silent once a richer screen exists', () => {
    // 3 screens, only 1 is a manifest Activity → richScreens 2 → no under-detection warning.
    const out = msgs({ screenCount: 3, activityScreens: 1, appEntries: 1, totalNavEdges: 2 });
    expect(out.some((m) => m.includes('未识别出任何 Compose/布局/Fragment 屏幕'))).toBe(false);
  });

  it('Screen under-detection stays silent on a complete multi-Activity View app (C1)', () => {
    // 3 Activities, each its own screen, all-code UI (no Compose/layout/Fragment):
    // richScreens 0 but activityScreens>1 → legitimately complete, must NOT warn.
    const out = msgs({ screenCount: 3, activityScreens: 3, appEntries: 1, totalNavEdges: 2 });
    expect(out).toEqual([]);
  });

  it('a healthy nav graph produces no warnings', () => {
    expect(msgs({ screenCount: 10, activityScreens: 2, appEntries: 1, totalNavEdges: 12 })).toEqual([]);
  });
});
