/**
 * Phase-1 input-quality fixes — regression pins.
 *
 * Real-project audits (nowinandroid / AntennaPod / koler) surfaced four ways the
 * migration inputs lied to the conversion agent; each gets a pin here:
 *   - test-scoped Gradle deps (testImplementation/…) ordered units and read as
 *     blocking prerequisites (B3);
 *   - test source sets leaked into the coupling projection / lifted deps,
 *     stitching unrelated features into one cluster and emitting reversed
 *     module coupling like `:feature:x → :app` (B4);
 *   - anonymous classes (`<Listener$anon@42>`) entered the T3 public-interface
 *     baseline, unfulfillable and line-number-unstable (B2);
 *   - `src/testDemo`-style variant test sets escaped the old fixed alternation
 *     in isTestPath (root of several of the above).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Node } from '../../src/types';
import { parseGradleModule, buildModuleGraph } from '../../src/appgraph/extractors/android/gradle';
import { computeMigrationOrder } from '../../src/migration/order/topo';
import { diffOrders, preserveTranslationOverlay } from '../../src/migration/cli';
import { emptyMigrationGraph, mergeInto } from '../../src/migration/types';
import { extractPublicInterface } from '../../src/migration/plan/context';
import { isTestPath } from '../../src/appgraph/detect/shared';
import { projectFileCoupling } from '../../src/appgraph/community/project';
import { buildModuleDependencyGraph } from '../../src/appgraph/modules';
import { CodeSymbolGraph } from '../../src/appgraph/graph-reader';
import { AppNode, AppEdge, makeNodeId, makeEdgeId } from '../../src/appgraph/schema';

function mkNode(id: string, filePath: string, kind: Node['kind'], name: string): Node {
  return {
    id,
    kind,
    name,
    qualifiedName: name,
    filePath,
    language: 'kotlin',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 0,
  };
}

function mkModule(name: string, dir: string): AppNode {
  const matchKey = `module:${name.replace(/[^a-z0-9]+/gi, '').toLowerCase()}`;
  return {
    id: makeNodeId('android', 'ArchModule', matchKey),
    kind: 'ArchModule',
    matchKey,
    name,
    platform: 'android',
    provenance: 'manifest',
    fidelity: 'source-project',
    confidence: 1,
    attrs: { dir },
  };
}

describe('B3 · gradle dependency scope', () => {
  it('captures the configuration and scopes test-only deps as test', () => {
    const kts = `
      dependencies {
        implementation(project(":core:model"))
        api(project(":core:common"))
        testImplementation(project(":core:testing"))
        androidTestImplementation(projects.core.datastoreTest)
        kspTest(project(":core:ksp"))
        implementation(projects.core.ui)
      }`;
    const mod = parseGradleModule('feature/topic', kts);
    const byPath = new Map(mod.dependencyPaths.map((d) => [d.path, d.scope]));
    expect(byPath.get(':core:model')).toBe('main');
    expect(byPath.get(':core:common')).toBe('main');
    expect(byPath.get(':core:testing')).toBe('test');
    expect(byPath.get(':core:datastoreTest')).toBe('test');
    expect(byPath.get(':core:ksp')).toBe('test');
    expect(byPath.get(':core:ui')).toBe('main');
  });

  it('parses Groovy configuration-first form and lets main win over test', () => {
    const groovy = `
      dependencies {
        testImplementation project(':core:util')
        implementation project(':core:util')
        androidTestImplementation project(':core:harness')
      }`;
    const mod = parseGradleModule('app', groovy);
    const byPath = new Map(mod.dependencyPaths.map((d) => [d.path, d.scope]));
    expect(byPath.get(':core:util')).toBe('main'); // declared both ways — main wins
    expect(byPath.get(':core:harness')).toBe('test');
  });

  it('parses product flavors + flavor dimensions (Kotlin DSL and Groovy), surfaced on the module node', () => {
    const kts = `android {
      flavorDimensions += "environment"
      productFlavors {
        create("demo") { dimension = "environment" }
        register("prod") { dimension = "environment" }
      }
    }`;
    const mod = parseGradleModule('app', kts);
    expect(mod.flavors).toEqual(['demo', 'prod']);
    expect(mod.flavorDimensions).toEqual(['environment']);
    const { nodes } = buildModuleGraph([mod]);
    expect(nodes[0]!.attrs?.flavors).toEqual(['demo', 'prod']);
    expect(nodes[0]!.attrs?.flavorDimensions).toEqual(['environment']);

    // Groovy bare form.
    const groovy = `android {
      flavorDimensions "tier"
      productFlavors {
        free { dimension "tier" }
        paid { dimension "tier" }
      }
    }`;
    const g = parseGradleModule('app', groovy);
    expect(g.flavors).toEqual(['free', 'paid']);
    expect(g.flavorDimensions).toEqual(['tier']);

    // A flavor-less module carries no flavor attrs (byte-stability for the common case).
    const plain = parseGradleModule('core/data', 'android { namespace = "x" }');
    expect(plain.flavors).toEqual([]);
    const { nodes: plainNodes } = buildModuleGraph([plain]);
    expect(plainNodes[0]!.attrs?.flavors).toBeUndefined();
    expect(plainNodes[0]!.attrs?.flavorDimensions).toBeUndefined();
  });

  it('marks test-scoped depends_on edges and topo ordering ignores them', () => {
    const app = parseGradleModule('app', 'implementation(project(":lib"))\ntestImplementation(project(":testing"))');
    const lib = parseGradleModule('lib', '');
    const testing = parseGradleModule('testing', 'implementation(project(":app"))');
    const { nodes, edges } = buildModuleGraph([app, lib, testing]);

    const testEdges = edges.filter((e) => e.attrs?.scope === 'test');
    expect(testEdges).toHaveLength(1);

    // Without the scope filter app→testing→app is a cycle; with it, order is clean.
    const { order, stats } = computeMigrationOrder(nodes as AppNode[], edges as AppEdge[]);
    expect(stats.cyclicUnits).toBe(0);
    const seq = order.units.map((u) => u.label);
    expect(seq.indexOf(':lib')).toBeLessThan(seq.indexOf(':app'));
  });
});

describe('B2/B4 · test-path predicate + public interface', () => {
  it('isTestPath covers variant/fixture test source sets', () => {
    expect(isTestPath('app/src/test/kotlin/A.kt')).toBe(true);
    expect(isTestPath('app/src/androidTest/kotlin/A.kt')).toBe(true);
    expect(isTestPath('app/src/testDemo/kotlin/A.kt')).toBe(true);
    expect(isTestPath('core/src/testFixtures/kotlin/A.kt')).toBe(true);
    expect(isTestPath('core/src/screenshotTest/kotlin/A.kt')).toBe(true);
    expect(isTestPath('app/src/main/kotlin/A.kt')).toBe(false);
    expect(isTestPath('feature/latest/src/main/kotlin/A.kt')).toBe(false);
  });

  it('drops anonymous classes and variant-test files from the T3 baseline', () => {
    const members = extractPublicInterface([
      mkNode('a', 'app/src/main/kotlin/Real.kt', 'class', 'RealThing'),
      mkNode('b', 'app/src/main/kotlin/Real.kt', 'class', '<Listener$anon@42>'),
      mkNode('c', 'app/src/main/kotlin/Real.kt', 'class', '<anonymous>'),
      mkNode('d', 'app/src/testDemo/kotlin/T.kt', 'class', 'DemoOnlyTestHelper'),
    ]);
    expect(members.map((m) => m.name)).toEqual(['RealThing']);
  });

  it('excludes test files from the community coupling projection', () => {
    const nodes = [
      mkNode('n1', 'app/src/main/kotlin/A.kt', 'class', 'A'),
      mkNode('n2', 'lib/src/main/kotlin/B.kt', 'class', 'B'),
      mkNode('n3', 'app/src/test/kotlin/ATest.kt', 'class', 'ATest'),
    ];
    const fileToModuleDir = new Map([
      ['app/src/main/kotlin/A.kt', 'app'],
      ['lib/src/main/kotlin/B.kt', 'lib'],
      ['app/src/test/kotlin/ATest.kt', 'app'],
    ]);
    const edges = [
      { source: 'n1', target: 'n2', kind: 'calls' as const },
      { source: 'n3', target: 'n2', kind: 'calls' as const }, // test → main: must not couple
    ];
    const proj = projectFileCoupling(nodes, edges, fileToModuleDir);
    expect(proj.graph.hasNode('app/src/test/kotlin/ATest.kt')).toBe(false);
    expect(proj.graph.order).toBe(2); // only the two main files
  });
});

describe('B4 · lifted coupling over shipped code only + reverse-suspect', () => {
  it('skips test-source edges and flags reverse-of-declared lifted coupling', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-'));
    try {
      const w = (rel: string, s: string): void => {
        const f = path.join(root, rel);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, s, 'utf8');
      };
      w('app/build.gradle.kts', 'implementation(project(":lib"))');
      w('lib/build.gradle.kts', '');

      const nodes = [
        mkNode('a1', 'app/src/main/kotlin/A.kt', 'class', 'A'),
        mkNode('l1', 'lib/src/main/kotlin/L.kt', 'class', 'L'),
        mkNode('t1', 'app/src/test/kotlin/AT.kt', 'class', 'AT'),
      ];
      const edges = [
        { source: 'l1', target: 'a1', kind: 'references' as const }, // lib → app: reverse of declared
        { source: 't1', target: 'l1', kind: 'calls' as const }, // test → lib: must not lift
      ];
      const reader = {
        getAllNodes: () => nodes,
        getAllEdges: () => edges,
      } as unknown as CodeSymbolGraph;

      const result = buildModuleDependencyGraph(root, reader);
      const lifted = result.edges.filter((e) => e.provenance === 'lifted');
      expect(lifted).toHaveLength(1); // only lib→app; the test-source edge lifted nothing
      expect(lifted[0]!.attrs?.suspect).toBe('reverse-of-declared');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// B5 · sync recomputes the migration order and reports the delta. cmdSync's
// disk I/O is a thin shell over `computeMigrationOrder` + `diffOrders`; this pins
// that composition (a structural change → a detected, correctly-shaped delta).
describe('B5 · order recompute + diff', () => {
  const mod = (name: string): AppNode => ({
    id: makeNodeId('android', 'ArchModule', `module:${name}`),
    kind: 'ArchModule',
    matchKey: `module:${name}`,
    name: `:${name}`,
    platform: 'android',
    provenance: 'manifest',
    fidelity: 'source-project',
    confidence: 1,
    attrs: { dir: name },
  });
  const dep = (from: AppNode, to: AppNode): AppEdge => ({
    id: makeEdgeId('depends_on', from.id, to.id),
    kind: 'depends_on',
    from: from.id,
    to: to.id,
    provenance: 'manifest',
    confidence: 1,
  });
  const core = mod('core');
  const feat = mod('feature');
  const app = mod('app');
  const orderOf = (modules: AppNode[], edges: AppEdge[]) =>
    computeMigrationOrder(modules, edges).order;

  it('reports unchanged when the structure is identical', () => {
    const before = orderOf([core, feat, app], [dep(app, feat), dep(feat, core)]);
    const after = orderOf([core, feat, app], [dep(app, feat), dep(feat, core)]);
    expect(diffOrders(before, after)!.unchanged).toBe(true);
  });

  it('detects an added module', () => {
    const before = orderOf([core, app], [dep(app, core)]);
    const after = orderOf([core, feat, app], [dep(app, feat), dep(feat, core)]);
    const d = diffOrders(before, after)!;
    expect(d.unchanged).toBe(false);
    expect(d.unitsAdded).toContain(':feature');
    expect(d.unitsRemoved).toEqual([]);
  });

  it('detects a removed module', () => {
    const before = orderOf([core, feat, app], [dep(app, feat), dep(feat, core)]);
    const after = orderOf([core, app], [dep(app, core)]);
    const d = diffOrders(before, after)!;
    expect(d.unitsRemoved).toContain(':feature');
  });

  it('detects a reordering of shared units when a dependency flips', () => {
    // core→app then app→core: the leaf swaps, so the shared units reorder.
    const before = orderOf([core, app], [dep(app, core)]); // core(0), app(1)
    const after = orderOf([core, app], [dep(core, app)]); // app(0), core(1)
    const d = diffOrders(before, after)!;
    expect(d.reordered).toBe(true);
    expect(d.unchanged).toBe(false);
  });

  it('returns null when either order is missing (nothing to diff)', () => {
    expect(diffOrders(undefined, orderOf([core], []))).toBeNull();
    expect(diffOrders(orderOf([core], []), undefined)).toBeNull();
  });
});

// Orphan-accumulation fix: a structural rebuild starts from a FRESH graph and
// only carries the translation overlay forward, so stale nodes a prior run
// produced (but the new run doesn't) never linger. `preserveTranslationOverlay`
// is the carry-forward step; this pins that it moves ONLY the overlay.
describe('structural rebuild drops orphans, keeps the translation overlay', () => {
  const feature = (sig: string): AppNode => ({
    id: makeNodeId('android', 'Feature', `feature:${sig}`),
    kind: 'Feature',
    matchKey: `feature:${sig}`,
    name: sig,
    platform: 'android',
    subtype: 'cross-module',
    provenance: 'lifted',
    fidelity: 'source-project',
    confidence: 0.4,
    attrs: { sig },
  });
  const archModule = (name: string, attrs: Record<string, unknown> = {}): AppNode => ({
    id: makeNodeId('android', 'ArchModule', `module:${name}`),
    kind: 'ArchModule',
    matchKey: `module:${name}`,
    name: `:${name}`,
    platform: 'android',
    provenance: 'manifest',
    fidelity: 'source-project',
    confidence: 1,
    attrs: { dir: name, ...attrs },
  });
  const harmonyNode = (name: string): AppNode => ({
    id: makeNodeId('harmony', 'ArchModule', `module:${name}`),
    kind: 'ArchModule',
    matchKey: `module:${name}`,
    name,
    platform: 'harmony',
    provenance: 'manifest',
    fidelity: 'source-project',
    confidence: 1,
  });

  it('carries harmony nodes + maps_to + publicInterface baselines, drops stale android nodes', () => {
    const core = archModule('core', { publicInterface: ['CoreApi', 'CoreClient'] });
    const harmony = harmonyNode('coreEntry');
    const prior = emptyMigrationGraph({ platform: 'android', app: { name: 't', packageName: 'c' } });
    mergeInto(prior, {
      nodes: [core, feature('staleFeat'), harmony],
      edges: [
        { id: makeEdgeId('maps_to', core.id, harmony.id), kind: 'maps_to', from: core.id, to: harmony.id, provenance: 'manifest', confidence: 1 },
      ],
    });

    // Fresh rebuild: the module is back (no baseline attr yet), but the stale
    // Feature the prior run produced is NOT re-emitted.
    const fresh = emptyMigrationGraph({ platform: 'android', app: { name: 't', packageName: 'c' } });
    mergeInto(fresh, { nodes: [archModule('core')] });

    preserveTranslationOverlay(fresh, prior);

    // Stale android Feature is gone (orphan eliminated).
    expect(fresh.nodes.some((n) => n.kind === 'Feature')).toBe(false);
    // Harmony node + maps_to edge carried forward.
    expect(fresh.nodes.some((n) => n.platform === 'harmony')).toBe(true);
    expect(fresh.edges.some((e) => e.kind === 'maps_to')).toBe(true);
    // publicInterface baseline re-attached to the fresh ArchModule.
    const freshCore = fresh.nodes.find((n) => n.id === core.id)!;
    expect(freshCore.attrs?.publicInterface).toEqual(['CoreApi', 'CoreClient']);
  });

  it('is a no-op when there is no prior graph', () => {
    const fresh = emptyMigrationGraph({ platform: 'android', app: { name: 't', packageName: 'c' } });
    mergeInto(fresh, { nodes: [archModule('core')] });
    const before = JSON.stringify(fresh);
    preserveTranslationOverlay(fresh, null);
    expect(JSON.stringify(fresh)).toBe(before);
  });
});
