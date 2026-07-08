/**
 * Migration layer — core-invariant guards for the cross-platform migration graph.
 *
 * Locks the plan's acceptance criteria: deterministic clustering + serialization,
 * correct module assignment/aggregation, bottom-up SCC ordering, and API→capability
 * detection. Pure-function tests (no codegraph DB); a final conditional test runs
 * the module skeleton against the real nowinandroid sample when present.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Node, Edge } from '../../src/types';
import { assignNodesToModules } from '../../src/migration/modules/assign';
import { aggregateModuleDependencies } from '../../src/migration/modules/aggregate';
import { computeMigrationOrder } from '../../src/migration/order/topo';
import { projectFileCoupling } from '../../src/migration/community/project';
import { detectCommunities } from '../../src/migration/community/detect';
import { apiToCapability, harmonyTargetFor } from '../../src/migration/capabilities-ext';
import { serializeMigrationGraph, hashMigrationGraph } from '../../src/migration/serialize';
import { emptyMigrationGraph, mergeInto } from '../../src/migration/types';
import { extractModuleSkeleton } from '../../src/migration/modules/gradle-ext';
import { AppNode, AppEdge, makeNodeId, makeEdgeId } from '../../src/migration/schema';

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

function mkEdge(source: string, target: string, kind: Edge['kind']) {
  return { source, target, kind };
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

function dependsOn(from: AppNode, to: AppNode): AppEdge {
  return {
    id: makeEdgeId('depends_on', from.id, to.id),
    kind: 'depends_on',
    from: from.id,
    to: to.id,
    provenance: 'manifest',
    confidence: 1,
  };
}

describe('module assignment', () => {
  it('assigns by longest module-dir prefix and requires a path boundary', () => {
    const nodes = [
      mkNode('a', 'core/network/src/main/X.kt', 'class', 'X'),
      mkNode('b', 'app/src/main/Y.kt', 'class', 'Y'),
      mkNode('c', 'core/network/impl/src/Z.kt', 'class', 'Z'),
      mkNode('d', 'buildSrc/root.kt', 'class', 'Root'),
      mkNode('e', 'app-nia-catalog/src/W.kt', 'class', 'W'),
    ];
    const a = assignNodesToModules(nodes, ['app', 'core/network', 'core/network/impl']);
    expect(a.nodeToModuleDir.get('a')).toBe('core/network');
    expect(a.nodeToModuleDir.get('b')).toBe('app');
    expect(a.nodeToModuleDir.get('c')).toBe('core/network/impl'); // longest prefix wins
    expect(a.nodeToModuleDir.has('d')).toBe(false); // unassigned
    expect(a.nodeToModuleDir.has('e')).toBe(false); // 'app' is not a prefix of 'app-nia-catalog'
    expect(a.unassigned).toBe(2);
  });
});

describe('module aggregation', () => {
  it('lifts cross-module dependency edges, excludes same-module and imports', () => {
    const nodeToModuleId = new Map([
      ['n1', 'm1'],
      ['n2', 'm2'],
      ['n3', 'm1'],
    ]);
    const edges = [
      mkEdge('n1', 'n2', 'calls'), // cross m1->m2
      mkEdge('n3', 'n2', 'references'), // cross m1->m2
      mkEdge('n1', 'n3', 'calls'), // same module m1 — excluded
      mkEdge('n1', 'n2', 'imports'), // imports — excluded (always same-file semantics)
    ];
    const lifted = aggregateModuleDependencies(edges, nodeToModuleId);
    expect(lifted).toHaveLength(1);
    expect(lifted[0]).toMatchObject({ fromModuleId: 'm1', toModuleId: 'm2', weight: 2 });
  });
});

describe('migration order', () => {
  it('orders leaves (pure dependencies) first, using declared edges only', () => {
    const a = mkModule(':a', 'a');
    const b = mkModule(':b', 'b');
    const c = mkModule(':c', 'c');
    // a -> b -> c  (a depends on b depends on c). c is the leaf.
    const { order, stats } = computeMigrationOrder([a, b, c], [dependsOn(a, b), dependsOn(b, c)]);
    const seq = order.units.map((u) => u.label);
    expect(seq).toEqual([':c', ':b', ':a']);
    expect(stats.cyclicUnits).toBe(0);
  });

  it('collapses a dependency cycle into one atomic SCC unit', () => {
    const d = mkModule(':d', 'd');
    const e = mkModule(':e', 'e');
    const { order, stats } = computeMigrationOrder([d, e], [dependsOn(d, e), dependsOn(e, d)]);
    expect(order.units).toHaveLength(1);
    expect(order.units[0]!.cyclic).toBe(true);
    expect(order.units[0]!.moduleIds.sort()).toEqual([d.id, e.id].sort());
    expect(stats.largestCycle).toBe(2);
  });
});

describe('community detection determinism', () => {
  it('produces identical community fingerprints across runs', () => {
    // Two triangles bridged by a single edge → two communities.
    const nodes = ['a', 'b', 'c', 'x', 'y', 'z'].map((n) =>
      mkNode(n, `feature/${n <= 'c' ? 'one' : 'two'}/src/${n}.kt`, 'class', n)
    );
    const edges = [
      mkEdge('a', 'b', 'calls'),
      mkEdge('b', 'c', 'calls'),
      mkEdge('c', 'a', 'calls'),
      mkEdge('x', 'y', 'calls'),
      mkEdge('y', 'z', 'calls'),
      mkEdge('z', 'x', 'calls'),
      mkEdge('c', 'x', 'calls'), // bridge
    ];
    const fileToModule = new Map(nodes.map((n) => [n.filePath, 'm']));
    const sigs = () =>
      detectCommunities(projectFileCoupling(nodes, edges, fileToModule).graph)
        .map((c) => c.sig)
        .join(',');
    expect(sigs()).toBe(sigs());
    expect(detectCommunities(projectFileCoupling(nodes, edges, fileToModule).graph).length).toBeGreaterThan(0);
  });
});

describe('API → capability + HarmonyOS target', () => {
  it('maps known framework imports to capabilities with a target API', () => {
    expect(apiToCapability('androidx.room.Dao')).toBe('persistence.database');
    expect(apiToCapability('retrofit2.Retrofit')).toBe('network');
    expect(apiToCapability('androidx.work.WorkManager')).toBe('background.task');
    expect(apiToCapability('kotlin.collections.List')).toBeNull();
    expect(harmonyTargetFor('persistence.database')?.module).toContain('relationalStore');
  });
});

describe('serialization determinism', () => {
  it('hash is independent of the order nodes are merged in', () => {
    // mergeInto (how every stage builds the graph) sorts nodes/edges, so two
    // graphs merged in different orders are byte-identical.
    const g1 = emptyMigrationGraph({ platform: 'android', app: { name: 'x', packageName: 'p' } });
    mergeInto(g1, { nodes: [mkModule(':b', 'b'), mkModule(':a', 'a')] });
    const g2 = emptyMigrationGraph({ platform: 'android', app: { name: 'x', packageName: 'p' } });
    mergeInto(g2, { nodes: [mkModule(':a', 'a'), mkModule(':b', 'b')] });
    expect(hashMigrationGraph(g1)).toBe(hashMigrationGraph(g2));
    // Serialization is stable text (no volatile fields).
    expect(serializeMigrationGraph(g1)).toBe(serializeMigrationGraph(g1));
  });
});

describe('module skeleton against nowinandroid (when present)', () => {
  const sample = findSample('nowinandroid');
  it.runIf(sample)('extracts all settings-declared modules deterministically', () => {
    const s1 = extractModuleSkeleton(sample!);
    const s2 = extractModuleSkeleton(sample!);
    expect(s1.nodes.length).toBe(35); // exactly the settings.gradle.kts include count
    expect(s1.moduleDirs).toEqual(s2.moduleDirs);
    expect(s1.warnings).toHaveLength(0); // every declared module has a build file
  });
});

function findSample(name: string): string | null {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'references', 'samples', name);
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}
