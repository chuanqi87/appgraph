/**
 * M3 · migration order — SCC condensation + bottom-up topological order.
 *
 * `depends_on: A → B` means A needs B, so B must migrate BEFORE A. The order is
 * therefore a bottom-up topological sort: leaves (modules that depend on nothing
 * internal) go first, and each module lands only after everything it depends on.
 *
 * Dependency cycles are collapsed into strongly-connected components (Tarjan) —
 * a cycle can't be ordered internally, so its members become one atomic
 * migration unit that must be migrated together. Ties among ready units break by
 * a stable label so the order is reproducible.
 */

import { createHash } from 'node:crypto';
import { AppEdge, AppNode } from '../schema';
import { MigrationOrder, MigrationUnit } from '../types';

export interface OrderResult {
  order: MigrationOrder;
  stats: { unitCount: number; cyclicUnits: number; largestCycle: number; edgesUsed: number };
}

export interface OrderOptions {
  /**
   * Fold lifted (implicit-coupling) edges into the ordering graph too. OFF by
   * default: the DECLARED Gradle graph is a guaranteed DAG and is the build
   * ground truth, whereas lifted edges are lower-confidence and can be
   * bidirectional (cross-module call mis-resolution, shared test fixtures),
   * which spuriously fuses unrelated modules into one giant SCC. A genuine code
   * dependency is already implied by the declared (transitive) graph, so
   * declared-only ordering loses no real ordering constraint.
   */
  includeLifted?: boolean;
}

/**
 * Compute the bottom-up migration order over ArchModule SCCs.
 *
 * @param modules  ArchModule nodes
 * @param edges    all graph edges (only module→module `depends_on` are used)
 */
export function computeMigrationOrder(
  modules: AppNode[],
  edges: AppEdge[],
  opts: OrderOptions = {}
): OrderResult {
  const moduleIds = new Set(modules.map((m) => m.id));
  const nameById = new Map(modules.map((m) => [m.id, m.name]));

  // Adjacency over module→module depends_on. Declared edges (provenance
  // 'manifest') are the DAG backbone; lifted edges join only when asked.
  const adj = new Map<string, Set<string>>();
  for (const id of moduleIds) adj.set(id, new Set());
  let edgesUsed = 0;
  for (const e of edges) {
    if (e.kind !== 'depends_on') continue;
    if (!moduleIds.has(e.from) || !moduleIds.has(e.to) || e.from === e.to) continue;
    if (!opts.includeLifted && e.provenance !== 'manifest') continue;
    adj.get(e.from)!.add(e.to);
    edgesUsed++;
  }

  const sccs = tarjanSCC([...moduleIds].sort(), adj);

  // Condensation: SCC index per module, and edges between distinct SCCs.
  const sccOf = new Map<string, number>();
  sccs.forEach((members, i) => members.forEach((m) => sccOf.set(m, i)));
  const succ = new Map<number, Set<number>>(); // scc → dependency sccs (out)
  const pred = new Map<number, Set<number>>(); // scc → dependent sccs (in)
  for (let i = 0; i < sccs.length; i++) {
    succ.set(i, new Set());
    pred.set(i, new Set());
  }
  for (const [from, tos] of adj) {
    const fi = sccOf.get(from)!;
    for (const to of tos) {
      const ti = sccOf.get(to)!;
      if (fi !== ti) {
        succ.get(fi)!.add(ti);
        pred.get(ti)!.add(fi);
      }
    }
  }

  // Kahn from the sinks: emit an SCC once all its dependencies are emitted.
  const label = (i: number): string =>
    sccs[i]!.map((m) => nameById.get(m) ?? m).sort().join(',');
  const outstanding = new Map<number, number>();
  for (let i = 0; i < sccs.length; i++) outstanding.set(i, succ.get(i)!.size);

  const ready = (): number[] =>
    [...outstanding.entries()]
      .filter(([, n]) => n === 0)
      .map(([i]) => i)
      .sort((a, b) => label(a).localeCompare(label(b)));

  const units: MigrationUnit[] = [];
  let orderIndex = 0;
  const emitted = new Set<number>();
  let frontier = ready();
  while (frontier.length > 0) {
    for (const i of frontier) {
      if (emitted.has(i)) continue;
      emitted.add(i);
      outstanding.delete(i);
      const members = [...sccs[i]!].sort();
      units.push({
        id: unitId(members),
        moduleIds: members,
        label: label(i),
        order: orderIndex++,
        cyclic: members.length > 1,
      });
      for (const p of pred.get(i)!) {
        if (!emitted.has(p)) outstanding.set(p, (outstanding.get(p) ?? 1) - 1);
      }
    }
    frontier = ready();
  }

  const cyclicUnits = units.filter((u) => u.cyclic);
  return {
    order: { units },
    stats: {
      unitCount: units.length,
      cyclicUnits: cyclicUnits.length,
      largestCycle: cyclicUnits.reduce((mx, u) => Math.max(mx, u.moduleIds.length), 0),
      edgesUsed,
    },
  };
}

/** Iterative Tarjan strongly-connected-components; returns SCC member lists. */
function tarjanSCC(nodes: string[], adj: Map<string, Set<string>>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let counter = 0;

  for (const start of nodes) {
    if (index.has(start)) continue;
    // Explicit DFS stack of frames: (node, sorted neighbors, cursor).
    const frames: Array<{ node: string; neighbors: string[]; i: number }> = [
      { node: start, neighbors: [...(adj.get(start) ?? [])].sort(), i: 0 },
    ];
    index.set(start, counter);
    low.set(start, counter);
    counter++;
    stack.push(start);
    onStack.add(start);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      if (frame.i < frame.neighbors.length) {
        const w = frame.neighbors[frame.i++]!;
        if (!index.has(w)) {
          index.set(w, counter);
          low.set(w, counter);
          counter++;
          stack.push(w);
          onStack.add(w);
          frames.push({ node: w, neighbors: [...(adj.get(w) ?? [])].sort(), i: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(w)!));
        }
      } else {
        // Done with this node: if it's a root, pop its SCC.
        if (low.get(frame.node) === index.get(frame.node)) {
          const comp: string[] = [];
          for (;;) {
            const v = stack.pop()!;
            onStack.delete(v);
            comp.push(v);
            if (v === frame.node) break;
          }
          sccs.push(comp.sort());
        }
        frames.pop();
        const parent = frames[frames.length - 1];
        if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      }
    }
  }
  return sccs;
}

function unitId(sortedMembers: string[]): string {
  return createHash('sha1').update(sortedMembers.join('\0')).digest('hex').slice(0, 16);
}
