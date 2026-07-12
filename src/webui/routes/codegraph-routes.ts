/**
 * /api/codegraph/* — thin wrappers over the existing `CodeGraph` query API
 * (src/index.ts). No query logic lives here beyond parsing query-string
 * params and shaping the JSON response; every actual lookup delegates to a
 * method `CodeGraph` already exposes.
 */

import { CodeGraph } from '../../index';
import { Edge, EdgeKind, Language, Node, NodeKind, Subgraph, TraversalOptions } from '../../types';
import { Router, RouteResult } from '../router';
import { EdgeWithOther, NodeSummary } from '../wire-types';

type GetCodeGraph = () => CodeGraph | null;

function summarize(node: Node | null): NodeSummary | null {
  if (!node) return null;
  return { id: node.id, name: node.name, kind: node.kind, filePath: node.filePath, startLine: node.startLine };
}

function withOther(cg: CodeGraph, edges: Edge[], otherIdOf: (e: Edge) => string): EdgeWithOther[] {
  return edges.map((edge) => ({ edge, other: summarize(cg.getNode(otherIdOf(edge))) }));
}

const NOT_INDEXED: RouteResult = {
  body: {
    error:
      'This project has no CodeGraph index yet. Run "codegraph init" (and "codegraph index") in the project root, then restart the UI.',
  },
};

/** Default/ceiling for the CodeGraph-side subgraph view — a repo can have tens
 *  of thousands of nodes, so an unbounded expansion would freeze the canvas. */
const DEFAULT_SUBGRAPH_LIMIT = 150;
const MAX_SUBGRAPH_LIMIT = 500;

export function registerCodeGraphRoutes(router: Router, getCodeGraph: GetCodeGraph): void {
  router.get('/api/codegraph/stats', () => {
    const cg = getCodeGraph();
    if (!cg) return NOT_INDEXED;
    return { body: { stats: cg.getStats() } };
  });

  router.get('/api/codegraph/nodes', ({ query }) => {
    const cg = getCodeGraph();
    if (!cg) return NOT_INDEXED;

    const q = query.get('q') ?? '';
    const kinds = parseListParam(query, 'kind') as NodeKind[] | undefined;
    const languages = parseListParam(query, 'language') as Language[] | undefined;
    const includePatterns = parseListParam(query, 'file');
    const limit = clampInt(query.get('limit'), 50, 1, 500);
    const offset = clampInt(query.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);

    const results = cg.searchNodes(q, { kinds, languages, includePatterns, limit, offset });
    return {
      body: {
        results: results.map((r) => ({ node: r.node, score: r.score, highlights: r.highlights })),
        limit,
        offset,
        // No total: searchNodes doesn't compute one (see plan) — the client
        // treats "got fewer than `limit` results" as "last page".
        hasMore: results.length === limit,
      },
    };
  });

  router.get('/api/codegraph/nodes/:id', ({ params }) => {
    const cg = getCodeGraph();
    if (!cg) return NOT_INDEXED;
    const id = params.id ?? '';
    const node = cg.getNode(id);
    if (!node) return { status: 404, body: { error: `No node with id "${id}"` } };
    return {
      body: {
        node,
        incoming: withOther(cg, cg.getIncomingEdges(node.id), (e) => e.source),
        outgoing: withOther(cg, cg.getOutgoingEdges(node.id), (e) => e.target),
      },
    };
  });

  router.get('/api/codegraph/nodes/:id/code', async ({ params }) => {
    const cg = getCodeGraph();
    if (!cg) return NOT_INDEXED;
    const id = params.id ?? '';
    if (!cg.getNode(id)) return { status: 404, body: { error: `No node with id "${id}"` } };
    const code = await cg.getCode(id);
    return { body: { code } };
  });

  router.get('/api/codegraph/files', ({ query }) => {
    const cg = getCodeGraph();
    if (!cg) return NOT_INDEXED;

    const q = (query.get('q') ?? '').toLowerCase();
    const language = query.get('language');
    const limit = clampInt(query.get('limit'), 100, 1, 1000);
    const offset = clampInt(query.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);

    let files = cg.getFiles();
    if (q) files = files.filter((f) => f.path.toLowerCase().includes(q));
    if (language) files = files.filter((f) => f.language === language);
    files = [...files].sort((a, b) => a.path.localeCompare(b.path));

    const total = files.length;
    const page = files.slice(offset, offset + limit);
    return { body: { files: page, total, limit, offset } };
  });

  router.get('/api/codegraph/edges', ({ query }) => {
    const cg = getCodeGraph();
    if (!cg) return NOT_INDEXED;

    const kind = (query.get('kind') || undefined) as EdgeKind | undefined;
    const provenance = query.get('provenance') || undefined;
    const limit = clampInt(query.get('limit'), 100, 1, 500);
    const offset = clampInt(query.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);

    const { edges, total } = cg.listEdges({ kind, provenance }, limit, offset);
    const enriched = edges.map((edge) => ({
      edge,
      source: summarize(cg.getNode(edge.source)),
      target: summarize(cg.getNode(edge.target)),
    }));
    return { body: { edges: enriched, total, limit, offset } };
  });

  // Local subgraph around a starting node — the data source for the graph
  // canvas view. Deliberately NOT a whole-repo dump: `mode` picks which
  // existing bounded traversal to run, and the result is capped again at the
  // route layer as a hard backstop against a huge impact radius.
  router.get('/api/codegraph/subgraph', ({ query }) => {
    const cg = getCodeGraph();
    if (!cg) return NOT_INDEXED;

    const start = query.get('start');
    if (!start) return { status: 400, body: { error: 'Missing required "start" query param' } };
    if (!cg.getNode(start)) return { status: 404, body: { error: `No node with id "${start}"` } };

    const mode = query.get('mode') ?? 'impact';
    const depth = clampInt(query.get('depth'), 2, 1, 6);
    const limit = clampInt(query.get('limit'), DEFAULT_SUBGRAPH_LIMIT, 1, MAX_SUBGRAPH_LIMIT);
    const edgeKinds = parseListParam(query, 'edgeKind') as EdgeKind[] | undefined;

    let subgraph: Subgraph;
    if (mode === 'callgraph') {
      subgraph = cg.getCallGraph(start, depth);
    } else if (mode === 'traverse') {
      const options: TraversalOptions = { maxDepth: depth, limit, edgeKinds, includeStart: true };
      subgraph = cg.traverse(start, options);
    } else {
      subgraph = cg.getImpactRadius(start, depth);
    }

    // Subgraph.nodes is a Map — JSON.stringify collapses it to `{}`, so it
    // must be flattened to an array before the response leaves this layer.
    const allNodes = Array.from(subgraph.nodes.values());
    const nodes = allNodes.slice(0, limit);
    const nodeIds = new Set(nodes.map((n) => n.id));
    const edges = subgraph.edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));

    return {
      body: {
        nodes,
        edges,
        roots: subgraph.roots,
        truncated: allNodes.length > nodes.length,
      },
    };
  });

  // Directory-prefix subgraph — all code symbols within a module's source
  // directory plus all edges between them. Backs the unified graph's Level 2
  // (code symbols) when zooming into a module.
  router.get('/api/codegraph/dir-subgraph', ({ query }) => {
    const cg = getCodeGraph();
    if (!cg) return NOT_INDEXED;

    const dir = query.get('dir');
    if (!dir) return { status: 400, body: { error: 'Missing required "dir" query param' } };

    const limit = clampInt(query.get('limit'), 500, 1, MAX_SUBGRAPH_LIMIT);
    const result = cg.getDirSubgraph(dir, limit);
    return { body: result };
  });
}

function parseListParam(query: URLSearchParams, key: string): string[] | undefined {
  const values = query.getAll(key);
  if (values.length === 0) return undefined;
  const flat = values.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
  return flat.length > 0 ? flat : undefined;
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw != null ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
