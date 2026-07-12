/**
 * fetch() wrappers for the JSON API in ../routes/*.ts. Response shapes come
 * from ../wire-types (type-only — erased at bundle time), NOT from the route
 * modules directly or from appgraph/schema.ts: both pull in Node-only code
 * (CodeGraph, node:crypto) that the browser client's DOM-only tsconfig can't
 * resolve — see wire-types.ts's own comment for why.
 */

import type { Edge, FileRecord, GraphStats, Node, SearchResult } from '../../types';
import type { AppEdgeWithOther, AppGraphWire, AppNodeSummary, AppNodeWire, DrillDownTarget, EdgeWithOther, NodeSummary } from '../wire-types';
import type { LedgerWire, MigrationGraphWire } from '../wire-types';

export type { EdgeWithOther, NodeSummary, AppEdgeWithOther, AppNodeSummary, DrillDownTarget };

export interface StatusResponse {
  projectRoot: string;
  initialLayer: 'codegraph' | 'appgraph' | 'migration';
  codegraph: { indexed: boolean; stats: GraphStats | null };
  appgraph: { built: boolean };
  migration: { built: boolean; ledger: boolean };
}

export interface NodeSearchResponse {
  results: Array<Pick<SearchResult, 'node' | 'score' | 'highlights'>>;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface NodeDetailResponse {
  node: Node;
  incoming: EdgeWithOther[];
  outgoing: EdgeWithOther[];
}

export interface FilesResponse {
  files: FileRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface GlobalEdge {
  edge: Edge;
  source: NodeSummary | null;
  target: NodeSummary | null;
}

export interface EdgesResponse {
  edges: GlobalEdge[];
  total: number;
  limit: number;
  offset: number;
}

export interface SubgraphResponse {
  nodes: Node[];
  edges: Edge[];
  roots: string[];
  truncated: boolean;
}

export interface DirSubgraphResponse {
  nodes: Node[];
  edges: Edge[];
  truncated: boolean;
}

export interface AppGraphResponse {
  graph: AppGraphWire;
}

export interface AppNodeDetailResponse {
  node: AppNodeWire;
  incoming: AppEdgeWithOther[];
  outgoing: AppEdgeWithOther[];
  drillDown: DrillDownTarget[];
}

export interface MigrationGraphResponse {
  graph: MigrationGraphWire | null;
}

export interface MigrationLedgerResponse {
  ledger: LedgerWire | null;
}

class ApiError extends Error {}

async function request<T>(path: string): Promise<T> {
  const res = await fetch(path);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ApiError(`${res.status} ${res.statusText}`);
  }
  const maybeError = body as { error?: string };
  if (!res.ok) throw new ApiError(maybeError.error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

type QueryValue = string | number | string[] | undefined;

function qs(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) search.append(key, v);
    } else {
      search.set(key, String(value));
    }
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

export const api = {
  status: (): Promise<StatusResponse> => request('/api/status'),

  searchNodes: (opts: {
    q?: string;
    kind?: string[];
    language?: string[];
    file?: string[];
    limit?: number;
    offset?: number;
  }): Promise<NodeSearchResponse> => request(`/api/codegraph/nodes${qs(opts)}`),

  getNode: (id: string): Promise<NodeDetailResponse> => request(`/api/codegraph/nodes/${encodeURIComponent(id)}`),

  getNodeCode: (id: string): Promise<{ code: string | null }> =>
    request(`/api/codegraph/nodes/${encodeURIComponent(id)}/code`),

  listFiles: (opts: { q?: string; language?: string; limit?: number; offset?: number }): Promise<FilesResponse> =>
    request(`/api/codegraph/files${qs(opts)}`),

  listEdges: (opts: {
    kind?: string;
    provenance?: string;
    limit?: number;
    offset?: number;
  }): Promise<EdgesResponse> => request(`/api/codegraph/edges${qs(opts)}`),

  subgraph: (opts: {
    start: string;
    mode?: string;
    depth?: number;
    limit?: number;
    edgeKind?: string[];
  }): Promise<SubgraphResponse> => request(`/api/codegraph/subgraph${qs(opts)}`),

  dirSubgraph: (dir: string, limit?: number): Promise<DirSubgraphResponse> =>
    request(`/api/codegraph/dir-subgraph${qs({ dir, limit })}`),

  appGraph: (): Promise<AppGraphResponse> => request('/api/appgraph/graph'),

  appNode: (id: string): Promise<AppNodeDetailResponse> => request(`/api/appgraph/nodes/${encodeURIComponent(id)}`),

  migrationGraph: (): Promise<MigrationGraphResponse> => request('/api/migration/graph'),

  migrationLedger: (): Promise<MigrationLedgerResponse> => request('/api/migration/ledger'),
};
