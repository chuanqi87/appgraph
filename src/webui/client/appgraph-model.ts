/**
 * Client-side derived model over an AppGraph document. The whole graph is
 * small (tens–low-hundreds of nodes, served in one /api/appgraph/graph call),
 * so every "what contains what / what does this node point at" lookup is
 * pre-indexed here once per view mount instead of re-scanned per render.
 *
 * Pure + framework-free: takes the wire graph, returns indices. No DOM.
 */

import type { AppEdgeWire, AppGraphWire, AppNodeWire } from '../wire-types';

export interface AppGraphModel {
  graph: AppGraphWire;
  byId: Map<string, AppNodeWire>;
  nodesByKind: Map<string, AppNodeWire[]>;
  /** Outgoing edges keyed by `from` node id. */
  outByNode: Map<string, AppEdgeWire[]>;
  /** Incoming edges keyed by `to` node id. */
  inByNode: Map<string, AppEdgeWire[]>;
  /** app_contains reverse lookup: for a node, the node(s) that contain it. */
  containersOf: Map<string, AppNodeWire[]>;
  /** app_contains forward: children of a container node (module/feature/screen). */
  childrenOf: Map<string, AppNodeWire[]>;
  /** Modules (ArchModule) sorted by name. */
  modules: AppNodeWire[];
  /** Every node with no containing node — ArchModules plus any screen/entry/
   *  capability/etc. that module detection didn't group under one. This is
   *  the node set the unified graph's Level 1 plots: restricting to `modules`
   *  alone silently drops ungrouped nodes from the canvas even though the
   *  sidebar's stat counts and legend still list them. */
  topLevelNodes: AppNodeWire[];
  /** Features sorted by name, grouped by role (attrs.role). */
  featuresByRole: Map<string, AppNodeWire[]>;
  /** Screens sorted by name. */
  screens: AppNodeWire[];
  /** Capabilities sorted by name. */
  capabilities: AppNodeWire[];
  /** Provenance counts across all nodes — the trust breakdown. */
  provenanceCounts: Record<string, number>;
  /** Edge counts by kind. */
  edgeKindCounts: Record<string, number>;
}

export function buildAppGraphModel(graph: AppGraphWire): AppGraphModel {
  const byId = new Map<string, AppNodeWire>();
  const nodesByKind = new Map<string, AppNodeWire[]>();
  for (const n of graph.nodes) {
    byId.set(n.id, n);
    push(nodesByKind, n.kind, n);
  }

  const outByNode = new Map<string, AppEdgeWire[]>();
  const inByNode = new Map<string, AppEdgeWire[]>();
  const childrenOf = new Map<string, AppNodeWire[]>();
  const containersOf = new Map<string, AppNodeWire[]>();

  for (const e of graph.edges) {
    push(outByNode, e.from, e);
    push(inByNode, e.to, e);
    if (e.kind === 'app_contains') {
      const child = byId.get(e.to);
      const parent = byId.get(e.from);
      if (child && parent) {
        push(childrenOf, e.from, child);
        push(containersOf, e.to, parent);
      }
    }
  }

  const modules = sortBy((nodesByKind.get('ArchModule') ?? []));
  const topLevelNodes = sortBy(
    graph.nodes.filter((n) => n.kind === 'ArchModule' || (containersOf.get(n.id) ?? []).length === 0)
  );
  const featuresByRole = new Map<string, AppNodeWire[]>();
  for (const f of nodesByKind.get('Feature') ?? []) {
    push(featuresByRole, roleOf(f), f);
  }
  const screens = sortBy(nodesByKind.get('Screen') ?? []);
  const capabilities = sortBy(nodesByKind.get('Capability') ?? []);

  const provenanceCounts: Record<string, number> = {};
  for (const n of graph.nodes) provenanceCounts[n.provenance] = (provenanceCounts[n.provenance] ?? 0) + 1;

  const edgeKindCounts: Record<string, number> = {};
  for (const e of graph.edges) edgeKindCounts[e.kind] = (edgeKindCounts[e.kind] ?? 0) + 1;

  return {
    graph,
    byId,
    nodesByKind,
    outByNode,
    inByNode,
    containersOf,
    childrenOf,
    modules,
    topLevelNodes,
    featuresByRole,
    screens,
    capabilities,
    provenanceCounts,
    edgeKindCounts,
  };
}

/** Outgoing edges of one node, optionally filtered by kind. */
export function outgoing(model: AppGraphModel, id: string, kind?: string): AppEdgeWire[] {
  return (model.outByNode.get(id) ?? []).filter((e) => (kind ? e.kind === kind : true));
}

export function incoming(model: AppGraphModel, id: string, kind?: string): AppEdgeWire[] {
  return (model.inByNode.get(id) ?? []).filter((e) => (kind ? e.kind === kind : true));
}

/** The single module that contains a node (first app_contains parent of kind
 *  ArchModule). Screens/features/components are directly owned by a module. */
export function owningModule(model: AppGraphModel, id: string): AppNodeWire | null {
  const parents = model.containersOf.get(id) ?? [];
  return parents.find((p) => p.kind === 'ArchModule') ?? null;
}

/** Resolves the "other end" of an edge relative to a node id. */
export function otherEnd(model: AppGraphModel, e: AppEdgeWire, fromId: string): AppNodeWire | null {
  const otherId = e.from === fromId ? e.to : e.from;
  return model.byId.get(otherId) ?? null;
}

/** Whether a node's outgoing/incoming set for a kind is non-empty. */
export function hasRelation(model: AppGraphModel, id: string, kind: string): boolean {
  return outgoing(model, id, kind).length > 0 || incoming(model, id, kind).length > 0;
}

/** A Feature's advisory role label (subdivision / aligned / cross-module). */
export function roleOf(node: AppNodeWire): string {
  return typeof node.attrs?.role === 'string' ? node.attrs.role : node.subtype ?? 'aligned';
}

export function nodeKindCount(model: AppGraphModel, kind: string): number {
  return (model.nodesByKind.get(kind) ?? []).length;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

function sortBy(ns: AppNodeWire[]): AppNodeWire[] {
  return [...ns].sort((a, b) => a.name.localeCompare(b.name));
}
