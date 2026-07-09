/**
 * MigrationGraph — the sibling knowledge graph for cross-platform migration.
 *
 * Deliberately SEPARATE from `codegraph.db` (the code-symbol graph) and a
 * SUPERSET of the AppGraph node/edge vocabulary (`../appgraph/schema`). The
 * code graph is only the substrate we read from; the MigrationGraph is the
 * deliverable — the fact source for the migration units and their order.
 *
 * It reuses AppGraph's determinism primitives verbatim (`AppNode`/`AppEdge`,
 * `makeNodeId`, stable `matchKey`) so that:
 *   - two runs over unchanged source produce byte-identical output, and
 *   - nodes/edges are keyed by content (not line numbers), so incremental
 *     re-extraction reuses ids.
 *
 * The graph is built INCREMENTALLY by the CLI stages (modules → community →
 * capabilities → order → run → verify). Each stage merges new nodes/edges
 * (deduped by id) into the same document; `mergeInto` is the single merge
 * primitive that keeps the result order-stable.
 */

import {
  AppEdge,
  AppNode,
  AppPlatform,
  CoverageWarning,
} from '../appgraph/schema';
import { mergeGraphPart } from '../appgraph/merge';

export { compareNodes, compareEdges } from '../appgraph/merge';

export const MIGRATION_GRAPH_SCHEMA_VERSION = 2;

/**
 * One strongly-connected component of the module dependency graph — the atomic
 * migration unit. A trivial unit is a single module; a nontrivial (cyclic) unit
 * is a cluster of mutually-dependent modules that must migrate together.
 */
export interface MigrationUnit {
  /** Deterministic id derived from the sorted member module ids. */
  id: string;
  /** ArchModule node ids in this unit (SCC members; usually exactly one). */
  moduleIds: string[];
  /** Human-readable label (member module names, joined). */
  label: string;
  /** 0-based position in the bottom-up order — leaves (no internal deps) first. */
  order: number;
  /** True when this unit is a nontrivial SCC (a dependency cycle). */
  cyclic: boolean;
  /**
   * 0-based parallel wave: Kahn frontier round this unit became ready in. All
   * units sharing a wave have every dependency in strictly earlier waves, so a
   * scheduler may run them concurrently. (Absent in schema-v1 documents.)
   */
  wave?: number;
  /** Unit ids this unit directly depends on (must migrate first), sorted. */
  dependsOn?: string[];
}

/** Bottom-up migration order over module SCCs (produced by `migrate order`). */
export interface MigrationOrder {
  units: MigrationUnit[];
}

/**
 * The migration graph document. `nodes`/`edges` carry ArchModule / Feature /
 * Capability structure; `order` is attached once `migrate order` has run.
 */
export interface MigrationGraph {
  schemaVersion: number;
  source: { platform: AppPlatform; app: { name: string; packageName: string } };
  target: { platform: AppPlatform };
  nodes: AppNode[];
  edges: AppEdge[];
  order?: MigrationOrder;
  coverageWarnings: CoverageWarning[];
}

/** An empty migration graph for a fresh `source → target` migration. */
export function emptyMigrationGraph(
  source: MigrationGraph['source'],
  targetPlatform: AppPlatform = 'harmony'
): MigrationGraph {
  return {
    schemaVersion: MIGRATION_GRAPH_SCHEMA_VERSION,
    source,
    target: { platform: targetPlatform },
    nodes: [],
    edges: [],
    coverageWarnings: [],
  };
}

/**
 * Merge freshly-extracted nodes/edges/warnings into a graph, deduped by id.
 * Later stages overwrite earlier nodes of the SAME id (so a stage can enrich a
 * node's `attrs`), while edges are first-write-wins (an edge's identity already
 * encodes everything about it). Keeps the document order-stable by re-sorting.
 */
export function mergeInto(
  graph: MigrationGraph,
  part: { nodes?: AppNode[]; edges?: AppEdge[]; warnings?: CoverageWarning[] }
): void {
  mergeGraphPart(graph, part);
}
