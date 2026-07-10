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
import { LiftedDependency, aggregateModuleDependencies, liftedConfidence } from './aggregate';

/**
 * Minimum crossing-edge weight for a lifted coupling to count as STRONG enough
 * to suspect a convention-injected build dependency (matches the top
 * `liftedConfidence` tier). Below this the coupling is too weak to trust as a
 * missing declared dependency.
 */
const CONVENTION_COUPLING_MIN_WEIGHT = 10;

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

  // Convention-injected dependency sanity-check (P3.4): a build-logic convention
  // plugin can inject a `project(":core")` dependency (e.g. shadowsocks'
  // `setupApp()`) the regex parser can't see, so mobile/tv end up with a STRONG
  // implicit coupling to core but no declared edge — leaving them unordered in
  // the declared graph and liable to a wave inversion. We do NOT synthesize a
  // declared edge (implicit edges carry false positives); we surface a warning.
  const nameById = new Map(nodes.map((n) => [n.id, n.name]));
  const conventionWarnings = conventionDependencyWarnings(skeleton.edges, lifted, nameById);

  let assignedNodes = 0;
  for (const ids of assignment.moduleToNodeIds.values()) assignedNodes += ids.size;

  return {
    packageName: skeleton.packageName,
    nodes,
    edges,
    warnings: [...skeleton.warnings, ...conventionWarnings],
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

/**
 * Flag strong implicit couplings that no declared dependency orders (in either
 * direction) — the fingerprint of a convention-plugin-injected `project(...)`
 * dependency the build-file regex can't see. Only STRONG couplings
 * (≥ `CONVENTION_COUPLING_MIN_WEIGHT`) where the declared graph constrains
 * neither `A→B` nor `B→A` qualify: a declared path either way already fixes the
 * order (so no inversion) or means the reverse coupling is resolver noise. One
 * warning per unordered module pair, sorted for determinism.
 */
function conventionDependencyWarnings(
  declaredEdges: AppEdge[],
  lifted: LiftedDependency[],
  nameById: Map<string, string>
): CoverageWarning[] {
  // Declared adjacency over MAIN-scoped edges only (test-scoped deps don't order units).
  const adj = new Map<string, Set<string>>();
  for (const e of declaredEdges) {
    if (e.attrs?.scope === 'test') continue;
    let set = adj.get(e.from);
    if (!set) {
      set = new Set<string>();
      adj.set(e.from, set);
    }
    set.add(e.to);
  }
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>([from]);
    const stack = [...(adj.get(from) ?? [])];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === to) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const next of adj.get(cur) ?? []) stack.push(next);
    }
    return false;
  };

  const warnings: CoverageWarning[] = [];
  const seenPairs = new Set<string>();
  for (const dep of lifted) {
    const { fromModuleId: a, toModuleId: b, weight } = dep;
    if (a === b || weight < CONVENTION_COUPLING_MIN_WEIGHT) continue;
    if (reaches(a, b) || reaches(b, a)) continue; // already ordered → no inversion
    const pairKey = a < b ? `${a}\0${b}` : `${b}\0${a}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    const nameA = nameById.get(a) ?? a;
    const nameB = nameById.get(b) ?? b;
    warnings.push({
      message:
        `模块 ${nameA} 对 ${nameB} 有强隐式耦合(${weight} 条跨模块引用)却未在 build 文件声明依赖,` +
        `且拓扑上二者无声明约束——疑似 convention 插件注入的依赖(如 setupApp()→project(...)),波次可能倒挂,` +
        `请人工确认迁移顺序`,
    });
  }
  return warnings.sort((x, y) => x.message.localeCompare(y.message));
}
