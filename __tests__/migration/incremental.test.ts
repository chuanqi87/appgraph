/**
 * I1 · incremental sync diff.
 *
 * The stable, line-number-free node ids mean an unchanged module/capability
 * keeps its id across runs, so a plain id-set diff precisely isolates what
 * changed — which is what `migrate sync` reports. Verifies: no-change → unchanged;
 * a new capability on a module → that module flagged changed + capability added;
 * a removed module → flagged removed.
 */

import { describe, it, expect } from 'vitest';
import { diffMigrationGraphs } from '../../src/migration/incremental';
import { emptyMigrationGraph, mergeInto, MigrationGraph } from '../../src/migration/types';
import { AppEdge, AppNode, makeEdgeId, makeNodeId } from '../../src/migration/schema';

function mkModule(name: string, symbolCount: number): AppNode {
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
    attrs: { dir: name.replace(/^:/, ''), symbolCount },
  };
}

function mkCapability(id: string): AppNode {
  const matchKey = `capability:${id}`;
  return {
    id: makeNodeId('android', 'Capability', matchKey),
    kind: 'Capability',
    matchKey,
    name: id,
    platform: 'android',
    provenance: 'lifted',
    fidelity: 'source-project',
    confidence: 0.9,
  };
}

function usesCapability(module: AppNode, cap: AppNode): AppEdge {
  return {
    id: makeEdgeId('uses_capability', module.id, cap.id),
    kind: 'uses_capability',
    from: module.id,
    to: cap.id,
    provenance: 'lifted',
    confidence: 0.85,
  };
}

function graph(nodes: AppNode[], edges: AppEdge[] = []): MigrationGraph {
  const g = emptyMigrationGraph({ platform: 'android', app: { name: 'x', packageName: 'p' } });
  mergeInto(g, { nodes, edges });
  return g;
}

describe('I1 · migration graph diff', () => {
  it('reports no change when the graph is identical', () => {
    const a = mkModule(':core:network', 10);
    const cap = mkCapability('network');
    const before = graph([a, cap], [usesCapability(a, cap)]);
    const after = graph([a, cap], [usesCapability(a, cap)]);
    const diff = diffMigrationGraphs(before, after);
    expect(diff.unchanged).toBe(true);
    expect(diff.modules).toHaveLength(0);
  });

  it('flags a module that gains a capability', () => {
    const net = mkModule(':core:network', 10);
    const capNet = mkCapability('network');
    const capNotif = mkCapability('notification');
    const before = graph([net, capNet], [usesCapability(net, capNet)]);
    const after = graph(
      [net, capNet, capNotif],
      [usesCapability(net, capNet), usesCapability(net, capNotif)]
    );
    const diff = diffMigrationGraphs(before, after);
    expect(diff.unchanged).toBe(false);
    expect(diff.capabilities.added).toContain('notification');
    const changed = diff.modules.find((m) => m.name === ':core:network');
    expect(changed?.change).toBe('changed');
    expect(changed?.capabilitiesAdded).toContain('notification');
  });

  it('flags an added and a removed module with symbol-count movement', () => {
    const a = mkModule(':core:common', 5);
    const b = mkModule(':feature:foryou', 20);
    const bGrown = mkModule(':feature:foryou', 26); // same id as b, more symbols
    const c = mkModule(':feature:new', 3);
    const before = graph([a, b]);
    const after = graph([bGrown, c]);
    const diff = diffMigrationGraphs(before, after);
    const removed = diff.modules.find((m) => m.name === ':core:common');
    const added = diff.modules.find((m) => m.name === ':feature:new');
    const grown = diff.modules.find((m) => m.name === ':feature:foryou');
    expect(removed?.change).toBe('removed');
    expect(added?.change).toBe('added');
    expect(grown?.change).toBe('changed');
    expect(grown?.symbolCountBefore).toBe(20);
    expect(grown?.symbolCountAfter).toBe(26);
  });
});
