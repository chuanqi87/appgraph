/**
 * M3b · HarmonyOS manifest capabilities.
 *
 * The Android analogue is `manifest-capabilities.ts`. Because every HarmonyOS
 * module carries its own `module.json5` and the project model already knows
 * which modules exist, attribution is exact — there is no path-prefix guessing
 * of the kind the Android side needs.
 *
 * Emits ONLY the permission-derived half (Permission + Capability + the
 * ArchModule→Capability edges). The structural nodes from the same manifests
 * (AppEntry / BackgroundComponent / Resource) are produced by
 * `harmony-structure.ts` in the semantics stage, mirroring how Android splits
 * `detectManifestCapabilities` from `detectAndroidStructure`.
 */

import { AppEdge, AppNode, CoverageWarning, makeEdgeId } from '../schema';
import { loadHarmonyProject } from '../extractors/harmony/project';
import { extractHarmonyManifest } from '../extractors/harmony/manifest';
import { harmonyTargetFor } from './api-capabilities';
import type { ManifestCapabilityResult, ModuleRef } from './manifest-capabilities';

/** Parse every module's `module.json5` and lift its permission-backed capabilities. */
export function detectHarmonyManifests(
  projectRoot: string,
  modules: ModuleRef[] = []
): ManifestCapabilityResult {
  const project = loadHarmonyProject(projectRoot);
  const idByDir = new Map(modules.map((m) => [m.dir, m.id]));

  const permissionById = new Map<string, AppNode>();
  const capabilityById = new Map<string, AppNode>();
  const usesById = new Map<string, AppEdge>();
  const moduleCapabilities = new Map<string, Set<string>>();
  const warnings: CoverageWarning[] = [];
  let manifestCount = 0;

  for (const mod of project?.modules ?? []) {
    if (!mod.manifest) continue;
    manifestCount++;

    const extraction = extractHarmonyManifest(mod);
    warnings.push(...extraction.warnings);

    const ownerId = idByDir.get(mod.dir);
    for (const node of extraction.nodes) {
      if (node.kind === 'Permission') {
        permissionById.set(node.id, node);
      } else if (node.kind === 'Capability') {
        capabilityById.set(node.id, enrichCapability(node));
        if (ownerId) {
          const edge = usesEdge(ownerId, node.id);
          usesById.set(edge.id, edge);
          addModuleCapability(moduleCapabilities, ownerId, node.name);
        }
      }
    }
  }

  return {
    permissionNodes: sortById([...permissionById.values()]),
    capabilityNodes: sortById([...capabilityById.values()]),
    usesEdges: [...usesById.values()].sort((a, b) => a.id.localeCompare(b.id)),
    warnings,
    moduleCapabilities,
    stats: {
      manifestCount,
      permissionCount: permissionById.size,
      capabilityCount: capabilityById.size,
      usesEdges: usesById.size,
    },
  };
}

/**
 * Attach the HarmonyOS API target to a capability.
 *
 * On a HarmonyOS project this is not a translation hint but the canonical API
 * for the capability — useful for "which Kit does this app rely on" queries, and
 * it keeps a HarmonyOS Capability node shape-identical to an Android one.
 */
function enrichCapability(node: AppNode): AppNode {
  const target = harmonyTargetFor(node.name);
  if (!target) return node;
  return {
    ...node,
    attrs: {
      ...node.attrs,
      harmonyModule: target.module,
      harmonyNote: target.note,
      constructs: target.constructs ?? [],
    },
  };
}

function usesEdge(moduleId: string, capId: string): AppEdge {
  return {
    id: makeEdgeId('uses_capability', moduleId, capId),
    kind: 'uses_capability',
    from: moduleId,
    to: capId,
    provenance: 'manifest',
    confidence: 1,
    attrs: { source: 'manifest' },
  };
}

function addModuleCapability(
  map: Map<string, Set<string>>,
  moduleId: string,
  capId: string
): void {
  let set = map.get(moduleId);
  if (!set) {
    set = new Set<string>();
    map.set(moduleId, set);
  }
  set.add(capId);
}

function sortById(nodes: AppNode[]): AppNode[] {
  return nodes.sort((a, b) => a.id.localeCompare(b.id));
}
