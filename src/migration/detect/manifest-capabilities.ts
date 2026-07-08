/**
 * S1 · permission → capability, the highest-ROT source-side gap from phase 1.
 *
 * Phase 1's M3 only mapped framework/API imports to capabilities (`capabilities-ext`);
 * it never parsed AndroidManifest permissions, so the M4 diff missed the entire
 * permission-backed capability family (camera / location / notification / …).
 *
 * This closes that gap by REUSING appgraph's already-tested primitives verbatim:
 *   - `extractManifest` parses each `AndroidManifest.xml` deterministically, and
 *   - `androidPermissionToCapability` (inside it) normalizes permissions to the
 *     SAME `capability:<id>` vocabulary the API detector uses.
 *
 * We keep only the Permission + Capability nodes it produces (Screens/components
 * are S2's concern), attribute each capability to its owning ArchModule via a
 * longest-dir-prefix match, and enrich capabilities that have a HarmonyOS target
 * (`harmonyTargetFor`) so they anchor the LLM translation exactly like API caps.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { AppEdge, AppNode, CoverageWarning, makeEdgeId } from '../schema';
import { extractManifest } from '../extractors/android/manifest';
import { harmonyTargetFor } from '../capabilities-ext';

/** Directories that never hold shippable app manifests. */
const EXCLUDED_DIRS = new Set([
  'build',
  '.git',
  '.gradle',
  '.idea',
  'node_modules',
  '.appgraph',
  '.codegraph',
  '.migration',
]);

/** Source sets whose manifests declare test-only (not shipped) permissions. */
const TEST_SOURCE_SET_RE = /\/src\/(test|androidTest|androidtest|debug)\//i;

/** An ArchModule's identity for attribution (id + project-relative posix dir). */
export interface ModuleRef {
  id: string;
  name: string;
  dir: string;
}

export interface ManifestCapabilityResult {
  /** Raw `<uses-permission>` Permission nodes (kept for provenance). */
  permissionNodes: AppNode[];
  /** Capability nodes normalized to `capability:<id>` (mergeable with API caps). */
  capabilityNodes: AppNode[];
  /** uses_capability edges ArchModule → Capability (manifest = confidence 1). */
  usesEdges: AppEdge[];
  warnings: CoverageWarning[];
  /** module id → capability ids it declares via permissions (for LLM context). */
  moduleCapabilities: Map<string, Set<string>>;
  stats: {
    manifestCount: number;
    permissionCount: number;
    capabilityCount: number;
    usesEdges: number;
  };
}

/**
 * Parse every shippable AndroidManifest under `projectRoot` and lift the
 * permission-backed capabilities into the migration graph, attributing each to
 * its owning ArchModule when `modules` is provided.
 */
export function detectManifestCapabilities(
  projectRoot: string,
  modules: ModuleRef[] = []
): ManifestCapabilityResult {
  const manifests = findManifests(projectRoot).sort();
  const dirToModule = moduleDirIndex(modules);

  const permissionById = new Map<string, AppNode>();
  const capabilityById = new Map<string, AppNode>();
  const usesById = new Map<string, AppEdge>();
  const moduleCapabilities = new Map<string, Set<string>>();
  const warnings: CoverageWarning[] = [];

  for (const abs of manifests) {
    const relPath = toPosix(relative(projectRoot, abs));
    const owner = attributeModule(relPath, dirToModule);
    const label = owner?.name ?? topSegment(relPath);

    let source: string;
    try {
      source = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }

    const extraction = extractManifest(relPath, source, label);
    warnings.push(...extraction.warnings);

    for (const node of extraction.nodes) {
      if (node.kind === 'Permission') {
        permissionById.set(node.id, node);
      } else if (node.kind === 'Capability') {
        capabilityById.set(node.id, enrichCapability(node));
        const capId = idOf(node.matchKey);
        if (owner) {
          usesById.set(...usesEdge(owner.id, node.id));
          addModuleCapability(moduleCapabilities, owner.id, capId);
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
      manifestCount: manifests.length,
      permissionCount: permissionById.size,
      capabilityCount: capabilityById.size,
      usesEdges: usesById.size,
    },
  };
}

/** Add the HarmonyOS translation target to a manifest capability, when known. */
function enrichCapability(node: AppNode): AppNode {
  const target = harmonyTargetFor(idOf(node.matchKey));
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

function usesEdge(moduleId: string, capId: string): [string, AppEdge] {
  const id = makeEdgeId('uses_capability', moduleId, capId);
  return [
    id,
    {
      id,
      kind: 'uses_capability',
      from: moduleId,
      to: capId,
      provenance: 'manifest',
      confidence: 1,
      attrs: { source: 'manifest' },
    },
  ];
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

/** Longest module-dir prefix wins (same rule as the M1 node assignment). */
export function attributeModule(
  manifestRelPath: string,
  dirToModule: Array<{ dir: string; ref: ModuleRef }>
): ModuleRef | null {
  for (const { dir, ref } of dirToModule) {
    if (manifestRelPath === dir || manifestRelPath.startsWith(`${dir}/`)) return ref;
  }
  return null;
}

/** Module dirs sorted longest-first so nested modules attribute correctly. */
export function moduleDirIndex(modules: ModuleRef[]): Array<{ dir: string; ref: ModuleRef }> {
  return modules
    .filter((m) => m.dir)
    .map((ref) => ({ dir: ref.dir, ref }))
    .sort((a, b) => b.dir.length - a.dir.length);
}

/** Every shippable `AndroidManifest.xml` (excludes build output + test source sets). */
export function findManifests(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) walk(full);
      } else if (entry.name === 'AndroidManifest.xml') {
        if (!TEST_SOURCE_SET_RE.test(toPosix(full))) out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

function sortById(nodes: AppNode[]): AppNode[] {
  return nodes.sort((a, b) => a.id.localeCompare(b.id));
}

/** `capability:network` → `network`. */
function idOf(matchKey: string): string {
  const idx = matchKey.indexOf(':');
  return idx >= 0 ? matchKey.slice(idx + 1) : matchKey;
}

export function topSegment(relPath: string): string {
  return relPath.split('/')[0] ?? relPath;
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}
