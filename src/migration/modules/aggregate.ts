/**
 * M1 · aggregation — the IMPLICIT half of the module dependency graph.
 *
 * Rolls the resolved code-symbol edges up to the module level: every code edge
 * whose endpoints live in two DIFFERENT modules becomes evidence for a
 * module→module `depends_on`, weighted by how many such edges cross. This is the
 * "两者结合" refinement at the module tier — it recovers coupling the build files
 * never declared (transitively-inherited deps, api-vs-impl leakage, …).
 *
 * Edge-kind choice: `imports` and `contains` are excluded. In codegraph an
 * `imports` edge points a file at its own local import declaration (always
 * same-file, so it never crosses a module) and `contains` is structural, not a
 * dependency. The real cross-module signal is the resolved call/reference graph —
 * exactly the kinds `GraphTraverser.getImpactRadius` traverses.
 */

import { EdgeKind } from '../../types';
import { CodeEdge } from '../graph-reader';

/** Dependency-bearing edge kinds — same set the impact/affected traversal uses. */
const DEPENDENCY_EDGE_KINDS = new Set<EdgeKind>([
  'calls',
  'references',
  'instantiates',
  'extends',
  'implements',
  'overrides',
  'type_of',
  'returns',
  'decorates',
]);

/** A lifted module→module coupling with its supporting evidence. */
export interface LiftedDependency {
  fromModuleId: string;
  toModuleId: string;
  /** Total number of crossing code edges (all dependency kinds). */
  weight: number;
  /** Per-kind breakdown, for auditing which coupling this is. */
  byKind: Record<string, number>;
}

/**
 * Aggregate cross-module code edges into weighted module dependencies.
 *
 * @param codeEdges       every edge from the code-symbol graph
 * @param nodeToModuleId  node id → owning ArchModule node id
 */
export function aggregateModuleDependencies(
  codeEdges: CodeEdge[],
  nodeToModuleId: Map<string, string>
): LiftedDependency[] {
  const byPair = new Map<string, LiftedDependency>();

  for (const edge of codeEdges) {
    if (!DEPENDENCY_EDGE_KINDS.has(edge.kind)) continue;
    const from = nodeToModuleId.get(edge.source);
    const to = nodeToModuleId.get(edge.target);
    if (from === undefined || to === undefined || from === to) continue;

    const key = `${from}\0${to}`;
    let dep = byPair.get(key);
    if (!dep) {
      dep = { fromModuleId: from, toModuleId: to, weight: 0, byKind: {} };
      byPair.set(key, dep);
    }
    dep.weight++;
    dep.byKind[edge.kind] = (dep.byKind[edge.kind] ?? 0) + 1;
  }

  return [...byPair.values()].sort(
    (a, b) =>
      a.fromModuleId.localeCompare(b.fromModuleId) ||
      a.toModuleId.localeCompare(b.toModuleId)
  );
}

/**
 * Confidence for a lifted edge, from its crossing-edge weight. Deterministic
 * tiers (not a curve) so the value is explainable and stable across runs; a
 * declared build-file dependency is always confidence 1 and overrides this.
 */
export function liftedConfidence(weight: number): number {
  if (weight >= 10) return 0.9;
  if (weight >= 3) return 0.7;
  return 0.5;
}
