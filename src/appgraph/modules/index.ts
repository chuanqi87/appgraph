/**
 * M1 · module dependency graph — orchestration.
 *
 * Combines the DECLARED module graph (build files, confidence 1) with the
 * IMPLICIT coupling lifted from the code-symbol graph (confidence < 1) into one
 * directed `depends_on` graph over ArchModule nodes — the input to SCC/topo
 * ordering (M3) and the substrate community detection refines (M2).
 */

import { AppEdge, AppNode, CoverageWarning, makeEdgeId } from '../schema';
import { CodeSymbolGraph } from '../graph-reader';
import { isTestPath } from '../detect/shared';
import { extractModuleSkeleton } from './gradle-ext';
import { ModuleAssignment, assignNodesToModules } from './assign';
import { aggregateModuleDependencies, liftedConfidence } from './aggregate';

export interface ModuleGraphResult {
  packageName: string | null;
  /** ArchModule nodes, each enriched with `attrs.symbolCount`. */
  nodes: AppNode[];
  /** depends_on edges: declared (confidence 1) merged with lifted (confidence < 1). */
  edges: AppEdge[];
  warnings: CoverageWarning[];
  moduleDirToId: Map<string, string>;
  assignment: ModuleAssignment;
  stats: {
    moduleCount: number;
    declaredDeps: number;
    liftedDeps: number;
    enrichedDeps: number;
    assignedNodes: number;
    unassignedNodes: number;
  };
}

/**
 * Build the module dependency graph for a source project whose code-symbol graph
 * is already open in `reader`.
 */
export function buildModuleDependencyGraph(
  sourceRoot: string,
  reader: CodeSymbolGraph
): ModuleGraphResult {
  const skeleton = extractModuleSkeleton(sourceRoot);

  const codeNodes = reader.getAllNodes();
  const assignment = assignNodesToModules(codeNodes, skeleton.moduleDirs);

  // node id → ArchModule node id (via the dir → id map).
  const nodeToModuleId = new Map<string, string>();
  for (const [nodeId, dir] of assignment.nodeToModuleDir) {
    const moduleId = skeleton.moduleDirToId.get(dir);
    if (moduleId) nodeToModuleId.set(nodeId, moduleId);
  }

  // Lifted coupling is computed over SHIPPED code only: a test calling into
  // another module is not an app dependency, and test-driven edges were the
  // main source of noisy/reversed implicit coupling in real projects.
  const fileByNodeId = new Map(codeNodes.map((n) => [n.id, n.filePath]));
  const mainNodeToModuleId = new Map<string, string>();
  for (const [nodeId, moduleId] of nodeToModuleId) {
    const file = fileByNodeId.get(nodeId);
    if (file !== undefined && !isTestPath(file)) mainNodeToModuleId.set(nodeId, moduleId);
  }
  const lifted = aggregateModuleDependencies(reader.getAllEdges(), mainNodeToModuleId);

  // Enrich ArchModule nodes with the count of code symbols assigned to them.
  const dirSymbolCount = new Map<string, number>();
  for (const [dir, ids] of assignment.moduleToNodeIds) dirSymbolCount.set(dir, ids.size);
  const nodes = skeleton.nodes.map((n): AppNode => {
    const dir = typeof n.attrs?.dir === 'string' ? n.attrs.dir : undefined;
    const symbolCount = dir !== undefined ? (dirSymbolCount.get(dir) ?? 0) : 0;
    return { ...n, attrs: { ...n.attrs, symbolCount } };
  });

  // Merge declared depends_on with lifted coupling, keyed by (from,to) edge id.
  const edgesById = new Map<string, AppEdge>();
  for (const e of skeleton.edges) edgesById.set(e.id, e);
  const liftedByPair = new Map(
    lifted.map((d) => [makeEdgeId('depends_on', d.fromModuleId, d.toModuleId), d])
  );

  const declaredPairs = new Set(skeleton.edges.map((e) => `${e.from}\0${e.to}`));

  let enrichedDeps = 0;
  let liftedDeps = 0;
  for (const [edgeId, dep] of liftedByPair) {
    const declared = edgesById.get(edgeId);
    if (declared) {
      // Declared dep stays authoritative (confidence 1); annotate the evidence.
      edgesById.set(edgeId, {
        ...declared,
        attrs: { ...declared.attrs, liftedWeight: dep.weight, liftedByKind: dep.byKind },
      });
      enrichedDeps++;
    } else {
      // A lifted edge running AGAINST a declared dependency is usually resolver
      // noise (name collisions, callback ownership) — kept in the graph for
      // audit, but flagged so plan/facts consumers can demote it.
      const reversed = declaredPairs.has(`${dep.toModuleId}\0${dep.fromModuleId}`);
      edgesById.set(edgeId, {
        id: edgeId,
        kind: 'depends_on',
        from: dep.fromModuleId,
        to: dep.toModuleId,
        provenance: 'lifted',
        confidence: liftedConfidence(dep.weight),
        attrs: {
          weight: dep.weight,
          byKind: dep.byKind,
          ...(reversed ? { suspect: 'reverse-of-declared' } : {}),
        },
      });
      liftedDeps++;
    }
  }

  const edges = [...edgesById.values()].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)
  );

  let assignedNodes = 0;
  for (const ids of assignment.moduleToNodeIds.values()) assignedNodes += ids.size;

  return {
    packageName: skeleton.packageName,
    nodes,
    edges,
    warnings: skeleton.warnings,
    moduleDirToId: skeleton.moduleDirToId,
    assignment,
    stats: {
      moduleCount: nodes.length,
      declaredDeps: skeleton.edges.length,
      liftedDeps,
      enrichedDeps,
      assignedNodes,
      unassignedNodes: assignment.unassigned,
    },
  };
}
