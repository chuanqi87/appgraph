/**
 * S2 · HarmonyOS structure — the manifest's non-permission facts.
 *
 * The Android analogue is `android-structure.ts`. Emits the structural nodes
 * `module.json5` declares and the edges provable from it alone:
 *
 *   AppEntry             the `mainElement` / launcher-skill ability
 *   BackgroundComponent  every other ability + all extensionAbilities
 *                        (`form` = home-screen widget, `backup` = backup agent)
 *   Resource             deep links from `skills[].uris`
 *   exposes              AppEntry/BackgroundComponent → Resource
 *   app_contains         ArchModule → each of the above
 *
 * Permissions from the same manifests are handled by
 * `harmony-manifest-capabilities.ts`; splitting them mirrors Android and keeps
 * each pass to one job.
 */

import { AppEdge, AppNode, CoverageWarning, makeEdgeId } from '../schema';
import { HarmonyProject } from '../extractors/harmony/project';
import { extractHarmonyManifest } from '../extractors/harmony/manifest';
import type { ModuleRef } from './manifest-capabilities';

export interface HarmonyStructureResult {
  nodes: AppNode[];
  edges: AppEdge[];
  warnings: CoverageWarning[];
  stats: {
    appEntries: number;
    backgroundComponents: number;
    deeplinks: number;
    containsEdges: number;
  };
}

const STRUCTURAL_KINDS = new Set(['AppEntry', 'BackgroundComponent', 'Resource']);

export function detectHarmonyStructure(
  project: HarmonyProject,
  modules: ModuleRef[]
): HarmonyStructureResult {
  const idByDir = new Map(modules.map((m) => [m.dir, m.id]));

  const nodeById = new Map<string, AppNode>();
  const edgeById = new Map<string, AppEdge>();
  const warnings: CoverageWarning[] = [];

  for (const mod of project.modules) {
    if (!mod.manifest) continue;

    const extraction = extractHarmonyManifest(mod);
    // Permission warnings belong to the capability pass — don't double-report.
    const ownerId = idByDir.get(mod.dir);

    for (const node of extraction.nodes) {
      if (!STRUCTURAL_KINDS.has(node.kind)) continue;
      nodeById.set(node.id, node);
      if (ownerId) {
        const edge = containsEdge(ownerId, node.id);
        edgeById.set(edge.id, edge);
      }
    }
    for (const edge of extraction.edges) {
      // `exposes` (entry → deep link) is the only edge kind the manifest proves.
      if (edge.kind === 'exposes') edgeById.set(edge.id, edge);
    }
  }

  const nodes = [...nodeById.values()];
  const appEntries = nodes.filter((n) => n.kind === 'AppEntry').length;
  const deeplinks = nodes.filter((n) => n.kind === 'Resource').length;

  // Anti-silence: a project with modules but no launcher ability means the
  // manifests were unreadable or the `mainElement`/skills convention was missed.
  // An empty entry list must never read as "this app has no entry point".
  if (appEntries === 0 && project.modules.some((m) => m.manifest)) {
    warnings.push({
      message:
        `未识别出任何应用入口(mainElement 或带 entity.system.home 的 ability)——` +
        `入口清单为空,不可当作"该应用无入口";请检查 module.json5 是否解析成功`,
    });
  }

  return {
    nodes: nodes.sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edgeById.values()].sort((a, b) => a.id.localeCompare(b.id)),
    warnings,
    stats: {
      appEntries,
      backgroundComponents: nodes.filter((n) => n.kind === 'BackgroundComponent').length,
      deeplinks,
      containsEdges: [...edgeById.values()].filter((e) => e.kind === 'app_contains').length,
    },
  };
}

function containsEdge(moduleId: string, nodeId: string): AppEdge {
  return {
    id: makeEdgeId('app_contains', moduleId, nodeId),
    kind: 'app_contains',
    from: moduleId,
    to: nodeId,
    provenance: 'manifest',
    confidence: 1,
  };
}
