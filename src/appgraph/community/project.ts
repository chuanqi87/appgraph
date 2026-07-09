/**
 * M2 · projection — collapse the symbol-level code graph into a file-level
 * weighted undirected coupling graph, the input to community detection.
 *
 * Every cross-file dependency edge (calls/references/inherit/…) between two
 * symbols becomes weight on the edge between their two files; the weight is the
 * count of crossing symbol edges. File is the projection unit because it is the
 * one grain every symbol has (`file_path` is 100% populated) and it maps cleanly
 * back to a module via the M1 assignment.
 *
 * Only files that participate in ≥1 cross-file coupling are added — an isolated
 * file forms a trivial singleton community that carries no functional-cluster
 * signal, so it is left out rather than clustered into noise.
 */

import Graph from 'graphology';
import { EdgeKind, Node } from '../../types';
import { CodeEdge } from '../graph-reader';
import { isTestPath } from '../detect/shared';

/** Same dependency-bearing kinds the module aggregation lifts (imports/contains excluded). */
const COUPLING_EDGE_KINDS = new Set<EdgeKind>([
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

export interface FileCouplingProjection {
  /** Undirected, weighted (`weight` edge attr). Node key = file path. */
  graph: Graph;
  /** Directed crossing counts `srcFile\0tgtFile → n`, for orienting Feature deps. */
  directed: Map<string, number>;
  /** file path → owning module dir (only coupled+assigned files). */
  fileToModuleDir: Map<string, string>;
  /** file path → number of code symbols in it. */
  fileSymbolCount: Map<string, number>;
}

/**
 * Build the file coupling graph.
 *
 * @param nodes            all code symbols
 * @param edges            all code edges
 * @param fileToModuleDir  file → module dir (from the M1 assignment); files not
 *                         in it are unassigned (root scripts, generated) and skipped
 */
export function projectFileCoupling(
  nodes: Node[],
  edges: CodeEdge[],
  fileToModuleDir: Map<string, string>
): FileCouplingProjection {
  const nodeIdToFile = new Map<string, string>();
  const fileSymbolCount = new Map<string, number>();
  for (const n of nodes) {
    // Test sources are excluded from the projection: a test that touches five
    // features would otherwise stitch those five features into one community
    // (the NiaApp 30-file/14-module grab-bag cluster came from exactly this).
    if (isTestPath(n.filePath)) continue;
    nodeIdToFile.set(n.id, n.filePath);
    if (fileToModuleDir.has(n.filePath)) {
      fileSymbolCount.set(n.filePath, (fileSymbolCount.get(n.filePath) ?? 0) + 1);
    }
  }

  // Accumulate undirected + directed crossing weights between assigned files.
  const undirected = new Map<string, number>(); // `a\0b` with a<b
  const directed = new Map<string, number>();
  for (const edge of edges) {
    if (!COUPLING_EDGE_KINDS.has(edge.kind)) continue;
    const a = nodeIdToFile.get(edge.source);
    const b = nodeIdToFile.get(edge.target);
    if (a === undefined || b === undefined || a === b) continue;
    if (!fileToModuleDir.has(a) || !fileToModuleDir.has(b)) continue;

    directed.set(`${a}\0${b}`, (directed.get(`${a}\0${b}`) ?? 0) + 1);
    const key = a < b ? `${a}\0${b}` : `${b}\0${a}`;
    undirected.set(key, (undirected.get(key) ?? 0) + 1);
  }

  // Deterministic build: sort node keys and edge keys before inserting so
  // graphology's internal ordering (and thus Louvain's) is reproducible.
  const graph = new Graph({ type: 'undirected', multi: false });
  const nodeSet = new Set<string>();
  for (const key of undirected.keys()) {
    const sep = key.indexOf('\0');
    nodeSet.add(key.slice(0, sep));
    nodeSet.add(key.slice(sep + 1));
  }
  for (const file of [...nodeSet].sort()) {
    graph.addNode(file, {
      module: fileToModuleDir.get(file),
      symbols: fileSymbolCount.get(file) ?? 0,
    });
  }
  for (const key of [...undirected.keys()].sort()) {
    const sep = key.indexOf('\0');
    graph.addEdge(key.slice(0, sep), key.slice(sep + 1), { weight: undirected.get(key)! });
  }

  const coupledFileToModuleDir = new Map<string, string>();
  for (const file of nodeSet) {
    const dir = fileToModuleDir.get(file);
    if (dir !== undefined) coupledFileToModuleDir.set(file, dir);
  }

  return { graph, directed, fileToModuleDir: coupledFileToModuleDir, fileSymbolCount };
}
