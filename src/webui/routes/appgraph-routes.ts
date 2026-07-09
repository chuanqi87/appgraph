/**
 * /api/appgraph/* — reads the already-built `.appgraph/app-graph.json` (via
 * the existing `readAppGraph`) and serves it to the UI. The document is small
 * (tens to low hundreds of nodes), so unlike the CodeGraph routes there's no
 * pagination here — the client filters the full graph locally.
 */

import { CodeGraph } from '../../index';
import { readAppGraph } from '../../appgraph/build';
import { appGraphPath } from '../../appgraph/paths';
import { AppEdge, AppNode } from '../../appgraph/schema';
import { Router, RouteResult } from '../router';
import { AppEdgeWithOther, AppNodeSummary, DrillDownTarget } from '../wire-types';

type GetCodeGraph = () => CodeGraph | null;

const NOT_BUILT: RouteResult = {
  body: {
    error: 'No .appgraph/app-graph.json found yet. Run "appgraph build <path>" first, then reload.',
  },
};

export function registerAppGraphRoutes(router: Router, root: string, getCodeGraph: GetCodeGraph): void {
  router.get('/api/appgraph/graph', () => {
    const graph = readAppGraph(appGraphPath(root));
    if (!graph) return NOT_BUILT;
    return { body: { graph } };
  });

  router.get('/api/appgraph/nodes/:id', ({ params }) => {
    const graph = readAppGraph(appGraphPath(root));
    if (!graph) return NOT_BUILT;

    const node = graph.nodes.find((n) => n.id === params.id);
    if (!node) return { status: 404, body: { error: `No AppNode with id "${params.id}"` } };

    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const summarize = (id: string): AppNodeSummary | null => {
      const n = byId.get(id);
      return n ? { id: n.id, name: n.name, kind: n.kind } : null;
    };

    return {
      body: {
        node,
        incoming: withOther(graph.edges.filter((e) => e.to === node.id), (e) => e.from, summarize),
        outgoing: withOther(graph.edges.filter((e) => e.from === node.id), (e) => e.to, summarize),
        drillDown: findDrillDownTargets(getCodeGraph(), node),
      },
    };
  });
}

function withOther(
  edges: AppEdge[],
  otherIdOf: (e: AppEdge) => string,
  summarize: (id: string) => AppNodeSummary | null
): AppEdgeWithOther[] {
  return edges.map((edge) => ({ edge, other: summarize(otherIdOf(edge)) }));
}

/**
 * Heuristic jump from an AppNode's `platformRef` to the CodeGraph symbol(s)
 * it was lifted from — convenience navigation, not a precise 1:1 mapping.
 * Matches by name/qualifiedName within the referenced file; falls back to
 * every symbol in that file when no `symbol` is recorded.
 */
function findDrillDownTargets(cg: CodeGraph | null, node: AppNode): DrillDownTarget[] {
  if (!cg || !node.platformRef) return [];
  const { file, symbol } = node.platformRef;
  const nodesInFile = cg.getNodesInFile(file);
  const matches = symbol
    ? nodesInFile.filter((n) => n.name === symbol || n.qualifiedName.endsWith(symbol))
    : nodesInFile;
  return matches.slice(0, 20).map((n) => ({ id: n.id, name: n.name, kind: n.kind, filePath: n.filePath }));
}
