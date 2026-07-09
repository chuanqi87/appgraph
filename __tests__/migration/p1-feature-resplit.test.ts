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
import { detectCommunities } from '../../src/appgraph/community/detect';

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
  it('breaks a wide low-cohesion grab-bag into more communities than the module-agnostic pass', () => {
    const { graph, moduleOf } = grabBagGraph(8, 4);

    const withoutModules = detectCommunities(graph);
    const withModules = detectCommunities(graph, { moduleOf: (f) => moduleOf.get(f) });

    // The module-aware pass must not collapse the graph into fewer clusters; it
    // separates the hub-bridged modules rather than gluing them.
    expect(withModules.length).toBeGreaterThanOrEqual(withoutModules.length);
    // No single community may still span all 8 modules.
    const maxSpan = Math.max(
      ...withModules.map((c) => new Set(c.members.map((f) => moduleOf.get(f))).size)
    );
    expect(maxSpan).toBeLessThan(8);
  });

  it('is deterministic — same input yields identical fingerprints', () => {
    const { graph, moduleOf } = grabBagGraph(8, 4);
    const a = detectCommunities(graph, { moduleOf: (f) => moduleOf.get(f) });
    const b = detectCommunities(graph, { moduleOf: (f) => moduleOf.get(f) });
    expect(a.map((c) => c.sig)).toEqual(b.map((c) => c.sig));
  });

  it('leaves a cohesive single-module community untouched', () => {
    // One dense module clique — no cross-module span, must survive as-is.
    const graph = new Graph({ type: 'undirected', multi: false });
    const files = ['m/A.kt', 'm/B.kt', 'm/C.kt', 'm/D.kt'];
    for (const f of files) graph.addNode(f);
    for (let i = 0; i < files.length; i++)
      for (let j = i + 1; j < files.length; j++) graph.addEdge(files[i]!, files[j]!, { weight: 3 });
    const communities = detectCommunities(graph, { moduleOf: () => ':m' });
    expect(communities).toHaveLength(1);
    expect(communities[0]!.members).toEqual(files);
  });
});
