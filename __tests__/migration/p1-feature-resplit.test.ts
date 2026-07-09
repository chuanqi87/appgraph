/**
 * P1-4 · module-span-aware Feature re-split + weak grab-bag flag.
 *
 * Real-project audit: nowinandroid's "NiaApp" Feature was one cluster of ~30
 * files across 14 modules, cohesion 0.094 — hub-bridged unrelated subsystems,
 * not a feature. The size/cohesion split passes miss it (wide but not huge,
 * cohesion above the 0.05 bar). P1-4 adds a module-span-aware re-split, and the
 * synthesis layer flags any surviving cross-module grab-bag as attrs.weak with
 * a lowered confidence.
 */

import { describe, it, expect } from 'vitest';
import Graph from 'graphology';
import { detectCommunities, resplitCrossModuleGrabBags } from '../../src/appgraph/community/detect';
import { isWeakGrabBag } from '../../src/appgraph/community/index';

/**
 * Build a "grab-bag": several tight per-module cliques connected only through a
 * single hub file. Dense within a module, thin across — exactly the shape the
 * module-span pass should pull apart and the size/cohesion passes leave whole.
 */
function grabBagGraph(moduleCount: number, perModule: number): {
  graph: Graph;
  moduleOf: Map<string, string>;
} {
  const graph = new Graph({ type: 'undirected', multi: false });
  const moduleOf = new Map<string, string>();
  const hub = 'hub/Hub.kt';
  graph.addNode(hub);
  moduleOf.set(hub, 'app');
  for (let m = 0; m < moduleCount; m++) {
    const files: string[] = [];
    for (let f = 0; f < perModule; f++) {
      const path = `mod${m}/File${f}.kt`;
      graph.addNode(path);
      moduleOf.set(path, `:mod${m}`);
      files.push(path);
    }
    // Dense clique inside the module.
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) graph.addEdge(files[i]!, files[j]!, { weight: 5 });
    }
    // One thin thread to the hub — the only cross-module coupling.
    graph.addEdge(hub, files[0]!, { weight: 1 });
  }
  return { graph, moduleOf };
}

describe('P1-4 · module-span-aware re-split', () => {
  it('consumes the moduleOfFile option without collapsing clusters, deterministically', () => {
    const { graph, moduleOf } = grabBagGraph(8, 4);

    const withoutModules = detectCommunities(graph);
    const withModules = detectCommunities(graph, { moduleOfFile: (f) => moduleOf.get(f) });

    // The module-aware pass must not collapse the graph into fewer clusters.
    expect(withModules.length).toBeGreaterThanOrEqual(withoutModules.length);
    // No single community may span all 8 modules.
    const maxSpan = Math.max(
      ...withModules.map((c) => new Set(c.members.map((f) => moduleOf.get(f))).size)
    );
    expect(maxSpan).toBeLessThan(8);
  });

  it('is deterministic — same input yields identical fingerprints', () => {
    const { graph, moduleOf } = grabBagGraph(8, 4);
    const a = detectCommunities(graph, { moduleOfFile: (f) => moduleOf.get(f) });
    const b = detectCommunities(graph, { moduleOfFile: (f) => moduleOf.get(f) });
    expect(a.map((c) => c.sig)).toEqual(b.map((c) => c.sig));
  });

  it('leaves a cohesive single-module community untouched', () => {
    // One dense module clique — no cross-module span, must survive as-is.
    const graph = new Graph({ type: 'undirected', multi: false });
    const files = ['m/A.kt', 'm/B.kt', 'm/C.kt', 'm/D.kt'];
    for (const f of files) graph.addNode(f);
    for (let i = 0; i < files.length; i++)
      for (let j = i + 1; j < files.length; j++) graph.addEdge(files[i]!, files[j]!, { weight: 3 });
    const communities = detectCommunities(graph, { moduleOfFile: () => ':m' });
    expect(communities).toHaveLength(1);
    expect(communities[0]!.members).toEqual(files);
  });

  /**
   * The re-split stage tested DIRECTLY. The first Louvain pass never emits a
   * wide, low-cohesion community (it splits any splittable cluster immediately),
   * so `resplitCrossModuleGrabBags` is fed a pre-formed cross-module community —
   * exactly what the M1→M2 pipeline hands it when real cross-module coupling
   * glues subsystems the first pass could not separate.
   */
  it('re-splits a wide (>6 modules), low-cohesion (<0.15) community that separates', () => {
    const graph = new Graph({ type: 'undirected', multi: false });
    const moduleOf = new Map<string, string>();
    const members: string[] = [];
    // Two dense 4-cliques (distinct connected components → Louvain yields ≥2),
    // each node in its own module (span = 8 across the two cliques).
    for (const [tag, base] of [['a', 0], ['b', 4]] as const) {
      const clique: string[] = [];
      for (let i = 0; i < 4; i++) {
        const f = `${tag}${i}/File.kt`;
        graph.addNode(f);
        moduleOf.set(f, `:m${base + i}`);
        members.push(f);
        clique.push(f);
      }
      for (let i = 0; i < clique.length; i++)
        for (let j = i + 1; j < clique.length; j++) graph.addEdge(clique[i]!, clique[j]!, { weight: 4 });
    }
    // 12 sparse satellite files, each its own module — drag cohesion below 0.15
    // (12 dense-clique edges over 20 nodes → 12/190 ≈ 0.063) and widen the span.
    for (let i = 0; i < 12; i++) {
      const f = `sat${i}/File.kt`;
      graph.addNode(f);
      moduleOf.set(f, `:s${i}`);
      members.push(f);
    }

    const before = [members];
    const after = resplitCrossModuleGrabBags(before, graph, (f) => moduleOf.get(f));

    // The single wide community must be broken up…
    expect(after.length).toBeGreaterThan(before.length);
    // …and no resulting part may still span >6 modules.
    const spanOf = (part: string[]): number =>
      new Set(part.map((f) => moduleOf.get(f)!)).size;
    expect(Math.max(...after.map(spanOf))).toBeLessThanOrEqual(6);
    // Every original member is preserved (nothing dropped).
    expect(after.flat().sort()).toEqual([...members].sort());
  });

  it('isWeakGrabBag flags only wide AND thin cross-module clusters (re-split window)', () => {
    // wide (>6) AND thin (<0.15) AND cross-module → weak.
    expect(isWeakGrabBag('cross-module', 7, 0.1)).toBe(true);
    // wide but COHESIVE (a real cross-cutting concern) → not weak.
    expect(isWeakGrabBag('cross-module', 10, 0.5)).toBe(false);
    // thin but NARROW (a small tight-ish grouping) → not weak.
    expect(isWeakGrabBag('cross-module', 3, 0.02)).toBe(false);
    // boundaries are strict (>6 and <0.15), not inclusive.
    expect(isWeakGrabBag('cross-module', 6, 0.1)).toBe(false);
    expect(isWeakGrabBag('cross-module', 7, 0.15)).toBe(false);
    // only cross-module Features are ever weak.
    expect(isWeakGrabBag('subdivision', 10, 0.01)).toBe(false);
    expect(isWeakGrabBag('aligned', 10, 0.01)).toBe(false);
  });

  it('leaves a wide but COHESIVE community whole (not a grab-bag)', () => {
    // 8 modules, but a single dense clique across them → cohesion ≫ 0.15, so the
    // span gate alone must NOT trigger a re-split.
    const graph = new Graph({ type: 'undirected', multi: false });
    const moduleOf = new Map<string, string>();
    const members: string[] = [];
    for (let i = 0; i < 8; i++) {
      const f = `m${i}/File.kt`;
      graph.addNode(f);
      moduleOf.set(f, `:m${i}`);
      members.push(f);
    }
    for (let i = 0; i < members.length; i++)
      for (let j = i + 1; j < members.length; j++)
        graph.addEdge(members[i]!, members[j]!, { weight: 3 });

    const after = resplitCrossModuleGrabBags([members], graph, (f) => moduleOf.get(f));
    expect(after).toHaveLength(1);
    expect(after[0]).toEqual(members);
  });
});
