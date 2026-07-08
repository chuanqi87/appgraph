/**
 * Order-stable graph merge — the single primitive every builder uses to fold
 * freshly-extracted nodes/edges/warnings into an accumulating graph document.
 *
 * Shared by the one-shot `buildAppGraph` and the migration pipeline's
 * incremental `mergeInto` so both produce byte-identical output: nodes are
 * last-write-wins by id (a later stage can enrich an earlier node's `attrs`),
 * edges are first-write-wins (an edge's identity already encodes everything),
 * and the document is kept sorted so serialization is deterministic.
 */

import { AppEdge, AppNode, CoverageWarning } from './schema';

/** The minimal graph-document shape `mergeGraphPart` mutates in place. */
export interface MergeableGraph {
  nodes: AppNode[];
  edges: AppEdge[];
  coverageWarnings: CoverageWarning[];
}

/**
 * Merge a fragment into `graph`, deduped by id and re-sorted. Nodes of the SAME
 * id overwrite (enrichment); edges are first-write-wins.
 */
export function mergeGraphPart(
  graph: MergeableGraph,
  part: { nodes?: AppNode[]; edges?: AppEdge[]; warnings?: CoverageWarning[] }
): void {
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const node of part.nodes ?? []) nodesById.set(node.id, node);

  const edgesById = new Map(graph.edges.map((e) => [e.id, e]));
  for (const edge of part.edges ?? []) {
    if (!edgesById.has(edge.id)) edgesById.set(edge.id, edge);
  }

  graph.nodes = [...nodesById.values()].sort(compareNodes);
  graph.edges = [...edgesById.values()].sort(compareEdges);

  if (part.warnings?.length) {
    graph.coverageWarnings = dedupeWarnings([...graph.coverageWarnings, ...part.warnings]);
  }
}

export function compareNodes(a: AppNode, b: AppNode): number {
  return (
    a.kind.localeCompare(b.kind) ||
    a.matchKey.localeCompare(b.matchKey) ||
    a.id.localeCompare(b.id)
  );
}

export function compareEdges(a: AppEdge, b: AppEdge): number {
  return (
    a.kind.localeCompare(b.kind) ||
    a.from.localeCompare(b.from) ||
    a.to.localeCompare(b.to) ||
    a.id.localeCompare(b.id)
  );
}

function dedupeWarnings(warnings: CoverageWarning[]): CoverageWarning[] {
  const seen = new Set<string>();
  const out: CoverageWarning[] = [];
  for (const w of warnings) {
    const key = `${w.message}|${w.ref?.file ?? ''}|${w.ref?.symbol ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(w);
    }
  }
  return out.sort((a, b) => a.message.localeCompare(b.message));
}
