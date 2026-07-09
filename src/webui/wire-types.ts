/**
 * JSON wire-format types shared between the web UI's server routes
 * (routes/*.ts) and browser client (client/api.ts). `Node`/`Edge` from
 * `../types` are safe to import directly here — that module has zero
 * imports of its own.
 *
 * AppGraph's real types (`../appgraph/schema.ts`) are deliberately NOT
 * imported here: that file pulls in `node:crypto` for its id-hashing
 * helpers, and once any export from it is type-imported, tsc must resolve
 * the whole file — which the browser client's DOM-only tsconfig (see
 * client/tsconfig.json) can't do. So the AppGraph shapes actually served
 * over the API are mirrored here structurally; real `AppNode`/`AppEdge`/
 * `AppGraph` objects already satisfy these interfaces field-for-field, they
 * just aren't imported by name on the server side either.
 */

import type { Edge } from '../types';

export interface NodeSummary {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  startLine: number;
}

export interface EdgeWithOther {
  edge: Edge;
  other: NodeSummary | null;
}

export interface GlobalEdge {
  edge: Edge;
  source: NodeSummary | null;
  target: NodeSummary | null;
}

export interface AppPlatformRefWire {
  file: string;
  symbol?: string;
}

export interface AppNodeWire {
  id: string;
  kind: string;
  matchKey: string;
  name: string;
  platform: string;
  subtype?: string;
  platformRef?: AppPlatformRefWire;
  provenance: string;
  fidelity: string;
  confidence: number;
  attrs?: Record<string, unknown>;
}

export interface AppEdgeWire {
  id: string;
  kind: string;
  from: string;
  to: string;
  provenance: string;
  confidence: number;
  attrs?: Record<string, unknown>;
}

export interface CoverageWarningWire {
  message: string;
  ref?: AppPlatformRefWire;
}

export interface AppGraphWire {
  schemaVersion: number;
  platform: string;
  app: { name: string; packageName: string };
  fidelity: string;
  supportedKinds: string[];
  nodes: AppNodeWire[];
  edges: AppEdgeWire[];
  coverageWarnings: CoverageWarningWire[];
}

export interface AppNodeSummary {
  id: string;
  name: string;
  kind: string;
}

export interface AppEdgeWithOther {
  edge: AppEdgeWire;
  other: AppNodeSummary | null;
}

export interface DrillDownTarget {
  id: string;
  name: string;
  kind: string;
  filePath: string;
}
