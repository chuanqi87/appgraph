/**
 * P · unit planning — size migration units to the work, not the project layout.
 *
 * Locks the packing rules: small units bin-pack by their root-excluded
 * dependent set (a project-wide root — nothing depends on it — is stripped
 * out first, so it can't defeat the comparison), a bin left with a single
 * real owner folds into it when capacity allows, a bin that's already
 * healthy-sized stands on its own, a reachability guard keeps same-key units
 * with a path between them apart, oversized single-module units split along
 * their M2 subdivision Features (remainder last), cyclic SCC units are never
 * split, the re-derived order stays bottom-up, and the whole layer is
 * deterministic and opt-out-able.
 */

import { describe, it, expect } from 'vitest';
import { AppEdge, AppNode, makeEdgeId, makeNodeId } from '../../src/appgraph/schema';
import { computeMigrationOrder } from '../../src/migration/order/topo';
import { emptyMigrationGraph, mergeInto, MigrationGraph } from '../../src/migration/types';
import {
  DEFAULT_PLANNING_OPTIONS,
  PlanningOptions,
  planUnits,
} from '../../src/migration/plan/unit-planning';

const OPTS: PlanningOptions = { ...DEFAULT_PLANNING_OPTIONS }; // min 120 · max 3000

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

function dependsOn(from: AppNode, to: AppNode, provenance: AppEdge['provenance'] = 'manifest'): AppEdge {
  return {
    id: makeEdgeId('depends_on', from.id, to.id),
    kind: 'depends_on',
    from: from.id,
    to: to.id,
    provenance,
    confidence: 1,
  };
}

function feature(
  name: string,
  sig: string,
  moduleId: string,
  members: string[],
  size = members.length
): AppNode {
  const matchKey = `feature:${sig}`;
  return {
    id: makeNodeId('android', 'Feature', matchKey),
    kind: 'Feature',
    matchKey,
    name,
    platform: 'android',
    subtype: 'subdivision',
    provenance: 'lifted',
    fidelity: 'source-project',
    confidence: 0.7,
    attrs: { sig, moduleSpan: [moduleId], members, size },
  };
}

/** Graph + order over the given modules/edges (reuses the real SCC topo). */
function fixture(nodes: AppNode[], edges: AppEdge[]): MigrationGraph {
  const graph = emptyMigrationGraph({ platform: 'android', app: { name: 't', packageName: 'c.t' } });
  mergeInto(graph, { nodes, edges });
  const modules = graph.nodes.filter((n) => n.kind === 'ArchModule');
  graph.order = computeMigrationOrder(modules, graph.edges).order;
  return graph;
}

function plan(graph: MigrationGraph, opts: PlanningOptions = OPTS) {
  return planUnits(graph.order!, graph, opts, new Map(), new Map());
}

describe('P · unit planning — merging', () => {
  it('bin-packs small leaf siblings that share an identical dependent set', () => {
    const app = archModule('app', 500);
    const x = archModule('x', 50);
    const y = archModule('y', 40);
    const z = archModule('z', 30);
    const graph = fixture([app, x, y, z], [dependsOn(app, x), dependsOn(app, y), dependsOn(app, z)]);

    const r = plan(graph);
    expect(r.units).toHaveLength(2);
    const [pack, top] = r.units;
    expect(pack!.kind).toBe('merged');
    expect(pack!.moduleIds.sort()).toEqual([x.id, y.id, z.id].sort());
    expect(pack!.symbolCount).toBe(120);
    expect(pack!.label).toBe(':x,:y,:z');
    // Bottom-up: the pack (app's dependency) migrates before app.
    expect(pack!.order).toBeLessThan(top!.order);
    expect(top!.kind).toBe('module');
    expect(r.stats.merged).toBe(2); // 4 units → 2
  });

  it('absorbs a small unit into its unique dependent, collapsing chains', () => {
    const app = archModule('app', 300);
    const core = archModule('core', 200);
    const util = archModule('util', 30);
    const graph = fixture([app, core, util], [dependsOn(app, core), dependsOn(core, util)]);

    const r = plan(graph);
    expect(r.units).toHaveLength(2);
    expect(r.units[0]!.kind).toBe('merged');
    expect(r.units[0]!.moduleIds.sort()).toEqual([core.id, util.id].sort());
    // The absorbed pair still precedes its dependent.
    expect(r.units[1]!.moduleIds).toEqual([app.id]);
  });

  it('never merges a small unit with two dependents, and respects order constraints', () => {
    const a = archModule('a', 200);
    const b = archModule('b', 200);
    const w = archModule('w', 30);
    const graph = fixture([a, b, w], [dependsOn(a, w), dependsOn(b, w)]);

    const r = plan(graph);
    expect(r.units).toHaveLength(3);
    const wUnit = r.units.find((u) => u.moduleIds.includes(w.id))!;
    expect(wUnit.kind).toBe('module');
    // w precedes both of its dependents.
    for (const u of r.units) {
      if (u.moduleIds.includes(a.id) || u.moduleIds.includes(b.id)) {
        expect(wUnit.order).toBeLessThan(u.order);
      }
    }
  });

  it('excludes a root from dependent-set comparison, revealing a fold a raw comparison would miss', () => {
    const app = archModule('app', 500); // root: nothing depends on it
    const impl = archModule('impl', 200); // real, non-root owner
    const api = archModule('api', 10); // depended on by both app and impl
    const graph = fixture(
      [app, impl, api],
      [dependsOn(app, impl), dependsOn(app, api), dependsOn(impl, api)]
    );
    const r = plan(graph);
    // Raw dependents of api = {app, impl} (size 2); excluding root app leaves
    // {impl} (size 1) — api folds into its one real owner.
    expect(r.units).toHaveLength(2);
    const pack = r.units.find((u) => u.moduleIds.includes(api.id))!;
    expect(pack.kind).toBe('merged');
    expect(pack.moduleIds.sort()).toEqual([impl.id, api.id].sort());
  });

  it('leaves a small unit alone when it has two real (non-root) owners', () => {
    const app = archModule('app', 500); // root
    const a = archModule('a', 200);
    const b = archModule('b', 200);
    const shared = archModule('shared', 10);
    const graph = fixture(
      [app, a, b, shared],
      [dependsOn(app, a), dependsOn(app, b), dependsOn(a, shared), dependsOn(b, shared)]
    );
    const r = plan(graph);
    // shared's root-excluded dependent set is {a, b} — two real owners, so
    // there's no unambiguous place to fold it.
    const sharedUnit = r.units.find((u) => u.moduleIds.includes(shared.id))!;
    expect(sharedUnit.kind).toBe('module');
    expect(sharedUnit.moduleIds).toEqual([shared.id]);
  });

  it('bin-packs many satellites of one capacity-limited owner into multiple groups, folding only what still fits', () => {
    const owner = archModule('owner', 2880); // 120 symbols of headroom under max(3000)
    const s1 = archModule('s1', 70);
    const s2 = archModule('s2', 110);
    const s3 = archModule('s3', 95);
    const s4 = archModule('s4', 20);
    const graph = fixture(
      [owner, s1, s2, s3, s4],
      [dependsOn(owner, s1), dependsOn(owner, s2), dependsOn(owner, s3), dependsOn(owner, s4)]
    );
    const r = plan(graph);
    // s1..s4 all share the same singleton-owner key. Bin-packing flushes
    // [s1,s2] once it crosses minUnitSymbols, leaving [s3,s4] as the trailing
    // (still-small) bin — only that one fits owner's remaining headroom, so
    // it folds in while [s1,s2] stands on its own instead of overflowing the
    // owner or being dropped one-by-one.
    expect(r.units).toHaveLength(2);
    const standalone = r.units.find((u) => !u.moduleIds.includes(owner.id))!;
    expect(standalone.moduleIds.sort()).toEqual([s1.id, s2.id].sort());
    const folded = r.units.find((u) => u.moduleIds.includes(owner.id))!;
    expect(folded.moduleIds.sort()).toEqual([owner.id, s3.id, s4.id].sort());
    expect(folded.symbolCount).toBe(2995);
  });

  it('never bin-packs two same-key units when one has a path to the other', () => {
    const p = archModule('p', 30); // root; also depends on v directly
    const ownerx = archModule('ownerx', 200); // a second root consumer of v
    const v = archModule('v', 30); // depended on only by roots p and ownerx
    const w = archModule('w', 25); // an unrelated root, safe to pack with v
    const graph = fixture([p, ownerx, v, w], [dependsOn(p, v), dependsOn(ownerx, v)]);

    const r = plan(graph);
    // p and v share the same (empty, root-excluded) dependent-set key, but p
    // has a direct path to v — merging them would fold a unit into something
    // it itself depends on. The reachability guard must keep them apart.
    const pUnit = r.units.find((u) => u.moduleIds.includes(p.id))!;
    const vUnit = r.units.find((u) => u.moduleIds.includes(v.id))!;
    expect(pUnit.moduleIds).not.toContain(v.id);
    expect(vUnit.moduleIds).not.toContain(p.id);
  });

  it('does not absorb past the max-unit threshold', () => {
    const host = archModule('host', 2990);
    const tiny = archModule('tiny', 50);
    const graph = fixture([host, tiny], [dependsOn(host, tiny)]);
    const r = plan(graph);
    expect(r.units).toHaveLength(2); // 2990 + 50 > 3000 → keep apart
    expect(r.units.every((u) => u.kind === 'module')).toBe(true);
  });
});

describe('P · unit planning — splitting', () => {
  function splitFixture() {
    const big = archModule('big', 4000);
    const f1 = feature('SyncHub', 'aaa', big.id, ['big/src/A.kt', 'big/src/B.kt']);
    const f2 = feature('UiHub', 'bbb', big.id, ['big/src/C.kt']);
    // f2 depends on f1 → f1 migrates first.
    const dep: AppEdge = {
      id: makeEdgeId('depends_on', f2.id, f1.id),
      kind: 'depends_on',
      from: f2.id,
      to: f1.id,
      provenance: 'lifted',
      confidence: 0.7,
      attrs: { scope: 'feature' },
    };
    const graph = fixture([big, f1, f2], [dep]);
    const files = new Map([[big.id, ['big/src/A.kt', 'big/src/B.kt', 'big/src/C.kt', 'big/src/D.kt']]]);
    const counts = new Map([
      ['big/src/A.kt', 1000],
      ['big/src/B.kt', 1000],
      ['big/src/C.kt', 900],
      ['big/src/D.kt', 1100],
    ]);
    return { big, graph, files, counts };
  }

  it('splits an oversized module along subdivision Features, remainder last', () => {
    const { big, graph, files, counts } = splitFixture();
    const r = planUnits(graph.order!, graph, OPTS, files, counts);

    expect(r.stats.split).toBe(1);
    expect(r.units).toHaveLength(3);
    const [u1, u2, u3] = r.units;
    expect(u1!.label).toBe(':big#SyncHub');
    expect(u1!.files).toEqual(['big/src/A.kt', 'big/src/B.kt']);
    expect(u1!.symbolCount).toBe(2000);
    expect(u2!.label).toBe(':big#UiHub');
    expect(u3!.label).toBe(':big#rest');
    expect(u3!.featureSig).toBe('rest');
    expect(u3!.files).toEqual(['big/src/D.kt']);
    expect(u3!.symbolCount).toBe(1100);
    expect(r.units.every((u) => u.kind === 'split' && u.moduleIds[0] === big.id)).toBe(true);
    // Orders are contiguous and stable.
    expect(r.units.map((u) => u.order)).toEqual([0, 1, 2]);
  });

  it('re-splits an oversized rest remainder by source directory (glue after features)', () => {
    const big = archModule('big', 12000);
    const f1 = feature('Feat', 'ffff', big.id, ['big/src/main/kotlin/app/feat/Screen.kt']);
    const graph = fixture([big, f1], []);
    const files = new Map([
      [
        big.id,
        [
          'big/src/main/kotlin/app/feat/Screen.kt', // covered by f1
          'big/src/main/kotlin/app/data/Repo.kt',
          'big/src/main/kotlin/app/data/Dao.kt',
          'big/src/main/kotlin/app/ui/View.kt',
        ],
      ],
    ]);
    const counts = new Map([
      ['big/src/main/kotlin/app/feat/Screen.kt', 4000],
      ['big/src/main/kotlin/app/data/Repo.kt', 2000],
      ['big/src/main/kotlin/app/data/Dao.kt', 500],
      ['big/src/main/kotlin/app/ui/View.kt', 2000],
    ]);
    const r = planUnits(graph.order!, graph, OPTS, files, counts);

    const restUnits = r.units.filter((u) => u.featureSig !== 'ffff');
    // rest = 4500 symbols across two package dirs → two directory slices, sorted.
    expect(restUnits.map((u) => u.label)).toEqual([':big#rest/app.data', ':big#rest/app.ui']);
    expect(restUnits.map((u) => u.featureSig)).toEqual([
      'rest:big/src/main/kotlin/app/data',
      'rest:big/src/main/kotlin/app/ui',
    ]);
    // Determinism: identical re-run.
    const r2 = planUnits(graph.order!, graph, OPTS, files, counts);
    expect(JSON.stringify(r)).toBe(JSON.stringify(r2));
    // rest slices are independent of each other; each depends on the feature slice.
    const featUnit = r.units.find((u) => u.featureSig === 'ffff')!;
    for (const u of restUnits) expect(u.dependsOnUnitIds).toEqual([featUnit.id]);
    expect(restUnits[0]!.wave).toBe(restUnits[1]!.wave); // parallel
  });

  it('re-slices a rest remainder UNDER maxUnitSymbols once it exceeds maxRestSymbols (P3.5)', () => {
    // The koler `:chooloolib#rest` shape: a module big enough to split, whose
    // remainder (1400 symbols across many packages) sits WELL under the
    // module-split cap (3000) yet is far too big to convert whole. The
    // remainder's own budget (maxRestSymbols=600) is what must catch it.
    const big = archModule('big', 5000);
    const f1 = feature('Feat', 'ffff', big.id, ['big/src/main/kotlin/app/feat/Screen.kt']);
    const graph = fixture([big, f1], []);
    const files = new Map([
      [
        big.id,
        [
          'big/src/main/kotlin/app/feat/Screen.kt', // covered by f1
          'big/src/main/kotlin/app/adapter/A.kt',
          'big/src/main/kotlin/app/data/D.kt',
          'big/src/main/kotlin/app/ui/V.kt',
        ],
      ],
    ]);
    const counts = new Map([
      ['big/src/main/kotlin/app/feat/Screen.kt', 3600],
      ['big/src/main/kotlin/app/adapter/A.kt', 500],
      ['big/src/main/kotlin/app/data/D.kt', 450],
      ['big/src/main/kotlin/app/ui/V.kt', 450],
    ]);
    // rest = 1400 symbols < maxUnitSymbols(3000), so the PRE-P3.5 threshold
    // would keep it a single monolith. With maxRestSymbols=600 it must split.
    const r = planUnits(graph.order!, graph, OPTS, files, counts);
    const restUnits = r.units.filter((u) => u.featureSig !== 'ffff');
    expect(restUnits.length).toBeGreaterThan(1);
    expect(restUnits.every((u) => u.symbolCount <= OPTS.maxRestSymbols)).toBe(true);
    expect(restUnits.map((u) => u.label)).toEqual([
      ':big#rest/app.adapter',
      ':big#rest/app.data',
      ':big#rest/app.ui',
    ]);
    // The whole `rest` sig is gone — no monolith remainder survives.
    expect(r.units.some((u) => u.featureSig === 'rest')).toBe(false);
  });

  it('re-slices a many-small-file rest remainder on the file cap even when symbols are low (P3.5)', () => {
    // 24 tiny files (1 symbol each) across two packages: 24 symbols total is far
    // under every symbol budget, but 24 files > maxRestFiles(20) overwhelms an
    // agent — the file dimension must force a split.
    const big = archModule('big', 4000);
    const f1 = feature('Feat', 'ffff', big.id, ['big/src/main/kotlin/app/feat/Screen.kt']);
    const graph = fixture([big, f1], []);
    const restFiles = [
      ...Array.from({ length: 12 }, (_, i) => `big/src/main/kotlin/app/a/F${i}.kt`),
      ...Array.from({ length: 12 }, (_, i) => `big/src/main/kotlin/app/b/F${i}.kt`),
    ];
    const files = new Map([[big.id, ['big/src/main/kotlin/app/feat/Screen.kt', ...restFiles]]]);
    const counts = new Map<string, number>([['big/src/main/kotlin/app/feat/Screen.kt', 3600]]);
    restFiles.forEach((f) => counts.set(f, 1));

    const r = planUnits(graph.order!, graph, OPTS, files, counts);
    const restUnits = r.units.filter((u) => u.featureSig !== 'ffff');
    expect(restUnits.length).toBeGreaterThan(1);
    expect(restUnits.every((u) => u.files!.length <= OPTS.maxRestFiles)).toBe(true);
  });

  it('never splits a cyclic SCC unit or a module without subdivision Features', () => {
    const a = archModule('cyca', 4000);
    const b = archModule('cycb', 4000);
    const graph = fixture([a, b], [dependsOn(a, b), dependsOn(b, a)]);
    const r = plan(graph);
    expect(r.units).toHaveLength(1);
    expect(r.units[0]!.cyclic).toBe(true);
    expect(r.units[0]!.kind).toBe('module');

    const lone = archModule('lone', 9000);
    const g2 = fixture([lone], []);
    const r2 = plan(g2);
    expect(r2.units).toHaveLength(1);
    expect(r2.units[0]!.kind).toBe('module');
  });
});

describe('P · unit planning — necessity-aware binning (T1-10)', () => {
  function devModule(name: string, symbolCount: number): AppNode {
    const m = archModule(name, symbolCount);
    return { ...m, attrs: { ...m.attrs, necessity: 'dev-only' } };
  }

  it('never bin-packs a product unit and a dev-only unit into the same bin', () => {
    // Two product roots consume every leaf → each leaf's root-excluded dependent
    // set is empty (bin-pack, don't fold). Product leaves and dev-only leaves
    // share that empty key but must NOT land in one bin.
    const r1 = archModule('r1', 200);
    const r2 = archModule('r2', 200);
    const p1 = archModule('design', 50); // product
    const p2 = archModule('ui', 40); // product
    const d1 = devModule('lint', 50); // dev-only
    const d2 = devModule('benchmark', 40); // dev-only
    const graph = fixture(
      [r1, r2, p1, p2, d1, d2],
      [
        dependsOn(r1, p1), dependsOn(r1, p2), dependsOn(r1, d1), dependsOn(r1, d2),
        dependsOn(r2, p1), dependsOn(r2, p2), dependsOn(r2, d1), dependsOn(r2, d2),
      ]
    );
    const r = plan(graph);

    // No unit mixes a product leaf with a dev-only leaf.
    const mixed = r.units.find(
      (u) =>
        (u.moduleIds.includes(p1.id) || u.moduleIds.includes(p2.id)) &&
        (u.moduleIds.includes(d1.id) || u.moduleIds.includes(d2.id))
    );
    expect(mixed).toBeUndefined();

    // The dev-only leaves pack together, flagged dev-only.
    const devPack = r.units.find((u) => u.moduleIds.includes(d1.id))!;
    expect(devPack.moduleIds.sort()).toEqual([d1.id, d2.id].sort());
    expect(devPack.necessity).toBe('dev-only');

    // The product leaves pack together, NOT flagged dev-only.
    const prodPack = r.units.find((u) => u.moduleIds.includes(p1.id))!;
    expect(prodPack.moduleIds.sort()).toEqual([p1.id, p2.id].sort());
    expect(prodPack.necessity).toBeUndefined();
  });

  it('is deterministic with dev-only modules present', () => {
    const app = archModule('app', 500);
    const p = archModule('design', 40);
    const d = devModule('lint', 40);
    const graph = fixture([app, p, d], [dependsOn(app, p), dependsOn(app, d)]);
    const a = plan(graph);
    const b = plan(graph);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('P · unit planning — invariants', () => {
  it('is deterministic and opt-out returns the SCC order 1:1', () => {
    const { graph, files, counts } = (() => {
      const app = archModule('app', 500);
      const x = archModule('x', 50);
      const y = archModule('y', 40);
      return {
        graph: fixture([app, x, y], [dependsOn(app, x), dependsOn(app, y)]),
        files: new Map<string, string[]>(),
        counts: new Map<string, number>(),
      };
    })();

    const a = planUnits(graph.order!, graph, OPTS, files, counts);
    const b = planUnits(graph.order!, graph, OPTS, files, counts);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));

    const off = planUnits(graph.order!, graph, { ...OPTS, enabled: false }, files, counts);
    expect(off.units).toHaveLength(graph.order!.units.length);
    expect(off.units.map((u) => u.moduleIds)).toEqual(
      [...graph.order!.units].sort((x1, y1) => x1.order - y1.order).map((u) => u.moduleIds)
    );
    expect(off.stats.merged).toBe(0);
    expect(off.stats.split).toBe(0);
  });

  it('only declared depends_on constrains packing (lifted edges are advisory)', () => {
    const app = archModule('app', 500);
    const x = archModule('x', 50);
    const y = archModule('y', 40);
    const graph = fixture(
      [app, x, y],
      [dependsOn(app, x), dependsOn(app, y), dependsOn(x, y, 'lifted')]
    );
    const r = plan(graph);
    // The lifted x→y edge does NOT stop x and y bin-packing as leaf siblings;
    // the pack (90 symbols, still small, unique dependent) then folds into app.
    expect(r.units).toHaveLength(1);
    expect(r.units[0]!.kind).toBe('merged');
    expect(r.units[0]!.moduleIds.sort()).toEqual([app.id, x.id, y.id].sort());
  });
});
