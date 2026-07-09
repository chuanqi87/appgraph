/**
 * buildAppGraph — the ONE deterministic source-side builder.
 *
 * Composes the platform-neutral app-semantic passes (M1 modules → M2 features →
 * M3 capabilities → U semantics) over a code-symbol graph into a single
 * `AppGraph` document. This is the shared builder the plan calls for: both
 * `appgraph build` (one-shot, writes `.appgraph/app-graph.json`) and the
 * migration pipeline's `rebuildStructuralGraph` call it, so their node/edge sets
 * are identical by construction — the merge order here IS the parity contract.
 *
 * v1 covers the Android source pipeline; HarmonyOS/iOS producers arrive in their
 * own phases and plug in behind the same `platform` switch.
 */

import { basename, dirname } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  APP_GRAPH_SCHEMA_VERSION,
  AppGraph,
  AppNode,
  AppNodeKind,
  AppPlatform,
} from './schema';
import { mergeGraphPart } from './merge';
import { canonicalJson } from './serialize';
import { CodeSymbolGraph } from './graph-reader';
import { buildModuleDependencyGraph } from './modules';
import { buildCommunityOverlay } from './community';
import { assignNodesToModules } from './modules/assign';
import { detectCapabilities } from './detect/api-capabilities';
import { detectManifestCapabilities, ModuleRef } from './detect/manifest-capabilities';
import { buildSemantics } from './detect/semantics';

/** Node kinds the source-side Android pipeline is able to emit. */
const SOURCE_SUPPORTED_KINDS: AppNodeKind[] = [
  'AppEntry',
  'Screen',
  'BackgroundComponent',
  'Permission',
  'Capability',
  'ArchModule',
  'Resource',
  'DataModel',
  'Feature',
];

export interface BuildAppGraphOptions {
  /** Target platform of the analyzed project. v1 builds Android. */
  platform?: AppPlatform;
  /** Package name to seed the app metadata with (module extraction overrides it if found). */
  packageName?: string;
}

/**
 * Build the full source-side app graph. Reuses the exact pass order + merge
 * primitive the migration stages use, so the result is byte-stable and matches
 * the migration graph's node/edge set node-for-node.
 */
export function buildAppGraph(
  root: string,
  reader: CodeSymbolGraph,
  options: BuildAppGraphOptions = {}
): AppGraph {
  const graph: AppGraph = {
    schemaVersion: APP_GRAPH_SCHEMA_VERSION,
    platform: options.platform ?? 'android',
    app: { name: basename(root), packageName: options.packageName ?? '' },
    fidelity: 'source-project',
    supportedKinds: [...SOURCE_SUPPORTED_KINDS],
    nodes: [],
    edges: [],
    coverageWarnings: [],
    navFrameworks: [],
  };

  // M1 · ArchModule + depends_on (declared ∪ lifted).
  const mod = buildModuleDependencyGraph(root, reader);
  if (mod.packageName) graph.app.packageName = mod.packageName;
  mergeGraphPart(graph, { nodes: mod.nodes, edges: mod.edges, warnings: mod.warnings });

  // M2 · deterministic Feature clusters.
  const archModules = graph.nodes.filter((n) => n.kind === 'ArchModule');
  const comm = buildCommunityOverlay(archModules, reader);
  mergeGraphPart(graph, { nodes: comm.nodes, edges: comm.edges, warnings: comm.warnings });

  // M3 · capabilities — API/framework imports, then AndroidManifest permissions.
  const api = detectCapabilities(reader.getAllNodes(), nodeToModuleId(archModules, reader));
  mergeGraphPart(graph, { nodes: api.capabilityNodes, edges: api.edges });
  const manifest = detectManifestCapabilities(root, moduleRefs(archModules));
  mergeGraphPart(graph, {
    nodes: [...manifest.permissionNodes, ...manifest.capabilityNodes],
    edges: manifest.usesEdges,
    warnings: manifest.warnings,
  });

  // U · source-side semantic enrichment (roles / screens+nav / entities / DI / flows / resources).
  const semantics = buildSemantics(reader, root, archModules, nodeToModuleId(archModules, reader));
  mergeGraphPart(graph, {
    nodes: semantics.nodes,
    edges: semantics.edges,
    warnings: semantics.warnings,
  });
  graph.navFrameworks = semantics.navFrameworks;

  return graph;
}

/** Map each code node id to its owning ArchModule id, via the M1 assignment. */
export function nodeToModuleId(
  archModules: AppNode[],
  reader: CodeSymbolGraph
): Map<string, string> {
  const moduleDirToId = new Map<string, string>();
  const moduleDirs: string[] = [];
  for (const m of archModules) {
    const dir = typeof m.attrs?.dir === 'string' ? m.attrs.dir : undefined;
    if (dir !== undefined) {
      moduleDirToId.set(dir, m.id);
      moduleDirs.push(dir);
    }
  }
  const assignment = assignNodesToModules(reader.getAllNodes(), moduleDirs);
  const map = new Map<string, string>();
  for (const [nid, dir] of assignment.nodeToModuleDir) {
    const mid = moduleDirToId.get(dir);
    if (mid) map.set(nid, mid);
  }
  return map;
}

/** ArchModule nodes → the {id,name,dir} refs the manifest attributor needs. */
export function moduleRefs(archModules: AppNode[]): ModuleRef[] {
  const refs: ModuleRef[] = [];
  for (const m of archModules) {
    const dir = typeof m.attrs?.dir === 'string' ? m.attrs.dir : undefined;
    if (dir !== undefined) refs.push({ id: m.id, name: m.name, dir });
  }
  return refs;
}

/** Persist an app graph (creating `.appgraph/` if needed). Byte-stable output. */
export function writeAppGraph(path: string, graph: AppGraph): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, canonicalJson(graph) + '\n', 'utf8');
}

/** Load a previously-written app graph, or null if none exists yet. */
export function readAppGraph(path: string): AppGraph | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as AppGraph;
  } catch {
    return null;
  }
}
