/**
 * T1-7 / T1-8 · community naming + build-file exclusion.
 *
 * T1-7: a cross-module cluster's advisory hub label must stay INSIDE the cluster's
 * primary module (the auth cluster must never be named after a `core/net` symbol);
 * a wide + thin cross-module grab-bag gets a neutral label instead of any member.
 * T1-8: Gradle/build scripts influenced the Louvain partition but are never product
 * features — they are dropped from membership and are never hub candidates.
 */

import { describe, it, expect } from 'vitest';
import Graph from 'graphology';
import { detectCommunities } from '../../src/appgraph/community/detect';
import { isBuildFilePath } from '../../src/appgraph/detect/shared';

function undirected(): Graph {
  return new Graph({ type: 'undirected', multi: false });
}
function clique(graph: Graph, nodes: string[], weight: number): void {
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++) graph.addEdge(nodes[i]!, nodes[j]!, { weight });
}

describe('T1-8 · isBuildFilePath', () => {
  it('flags Gradle build/settings scripts and build-logic modules', () => {
    for (const p of [
      'app/build.gradle.kts',
      'app/build.gradle',
      'settings.gradle.kts',
      'settings.gradle',
      'gradle/libs.gradle',
      'buildSrc/src/main/kotlin/Deps.kt',
      'build-logic/convention/src/main/kotlin/Plugin.kt',
      'tools/gen.py',
      'setup.py',
    ]) {
      expect(isBuildFilePath(p)).toBe(true);
    }
  });

  it('keeps product sources (incl. Python under a source set)', () => {
    for (const p of [
      'feature/home/src/main/kotlin/HomeScreen.kt',
      'core/network/ApiService.kt',
      'app/src/main/python/rules.py', // `.py` under a source set → product code
      'gradleview/Widget.kt', // "gradle" only as a substring, not a `.gradle` file
    ]) {
      expect(isBuildFilePath(p)).toBe(false);
    }
  });
});

describe('T1-7 · cross-module hub naming stays in the primary module', () => {
  it('names an auth cluster after an auth file, never the higher-degree net hub', () => {
    // K4 across two modules {auth ×3, net ×1} + a net pendant, so the globally
    // highest-degree node (ProductHuntService, degree 4) is in the SECONDARY
    // module, while auth (3 members) is the primary module.
    const graph = undirected();
    const auth = ['feature/auth/AuthRepo.kt', 'feature/auth/Login.kt', 'feature/auth/Register.kt'];
    const netHub = 'core/net/ProductHuntService.kt';
    const netLeaf = 'core/net/ApiClient.kt';
    for (const n of [...auth, netHub, netLeaf]) graph.addNode(n);
    clique(graph, [...auth, netHub], 5); // K4 auth+netHub
    graph.addEdge(netHub, netLeaf, { weight: 1 }); // pendant → netHub degree 4

    const moduleOf = (f: string): string => (f.startsWith('feature/auth/') ? ':auth' : ':net');
    const communities = detectCommunities(graph, { moduleOfFile: moduleOf });

    const c = communities.find((c) => c.members.includes('feature/auth/Login.kt'))!;
    expect(c).toBeTruthy();
    // Label is an auth member's base name — the net hub never leaks in.
    expect(['AuthRepo', 'Login', 'Register']).toContain(c.hubName);
    expect(c.hubName).not.toBe('ProductHuntService');
  });

  it('labels a wide + thin cross-module grab-bag with a neutral name', () => {
    // A star: one hub + 15 single-file modules, each attached only to the hub —
    // span 16 (>6), cohesion ≈0.125 (<0.15). It resists every split and survives
    // as one grab-bag, so naming it after any member would be misleading.
    const graph = undirected();
    const hub = 'app/App.kt';
    graph.addNode(hub);
    const moduleOf = new Map<string, string>([[hub, ':app']]);
    for (let i = 0; i < 15; i++) {
      const leaf = `m${i}/Leaf.kt`;
      graph.addNode(leaf);
      moduleOf.set(leaf, `:m${i}`);
      graph.addEdge(hub, leaf, { weight: 1 });
    }
    const communities = detectCommunities(graph, { moduleOfFile: (f) => moduleOf.get(f) });

    const grabBag = communities.find((c) => c.members.includes(hub))!;
    expect(grabBag).toBeTruthy();
    expect(new Set(grabBag.members.map((f) => moduleOf.get(f))).size).toBeGreaterThan(6);
    expect(grabBag.cohesion).toBeLessThan(0.15);
    expect(grabBag.hubName).toBe('杂合簇');
  });
});

describe('T1-8 · community build-file exclusion', () => {
  it('never names or includes a build script in a mixed cluster', () => {
    // A real home cluster with `app/build.gradle.kts` wired into it at the highest
    // degree — the gradle file must be dropped from membership and never the hub.
    const graph = undirected();
    const real = ['feature/home/Home.kt', 'feature/home/HomeRepo.kt', 'feature/home/HomeVM.kt'];
    const gradle = 'app/build.gradle.kts';
    for (const n of [...real, gradle]) graph.addNode(n);
    clique(graph, real, 5);
    for (const r of real) graph.addEdge(gradle, r, { weight: 5 }); // gradle degree 3

    const moduleOf = (f: string): string => (f === gradle ? ':build' : ':home');
    const communities = detectCommunities(graph, { moduleOfFile: moduleOf });

    for (const c of communities) {
      expect(c.members).not.toContain(gradle);
      expect(c.hubName).not.toMatch(/gradle/i);
    }
    const home = communities.find((c) => c.members.includes('feature/home/Home.kt'))!;
    expect(home.members).toEqual(['feature/home/Home.kt', 'feature/home/HomeRepo.kt', 'feature/home/HomeVM.kt']);
    expect(home.hubName).toBe('Home');
  });

  it('produces no cluster from a build-scripts-only module', () => {
    // Everything is a Gradle script → after the drop there is nothing to name.
    const graph = undirected();
    const buildFiles = ['app/build.gradle.kts', 'core/build.gradle.kts', 'settings.gradle.kts'];
    for (const n of buildFiles) graph.addNode(n);
    clique(graph, buildFiles, 5);
    const communities = detectCommunities(graph);
    expect(communities).toEqual([]);
  });
});
