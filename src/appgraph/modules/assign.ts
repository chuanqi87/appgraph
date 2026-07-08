/**
 * M1 · assignment — map each code symbol to the ArchModule that owns it.
 *
 * A node's `file_path` is project-relative (e.g. `core/network/src/main/.../X.kt`);
 * a module's dir is the prefix (`core/network`). Assignment is longest-prefix
 * match against the module dir set, so a nested module (`feature/foryou/impl`)
 * wins over its parent (`feature/foryou`) for files under it.
 *
 * `qualified_name` (100% populated, package-qualified) is not needed for the
 * mapping — the file path is authoritative and cheaper — but is available on the
 * nodes for downstream validation if a path ever proves ambiguous.
 */

import { Node } from '../../types';

export interface ModuleAssignment {
  /** node id → owning module dir (present only for nodes under some module). */
  nodeToModuleDir: Map<string, string>;
  /** module dir → set of node ids assigned to it. */
  moduleToNodeIds: Map<string, Set<string>>;
  /** file_path → owning module dir (memoized; reused by the aggregation pass). */
  fileToModuleDir: Map<string, string>;
  /** node ids that fell under no module (root scripts, build-logic, etc.). */
  unassigned: number;
}

/**
 * Assign nodes to modules by longest module-dir prefix of their file path.
 */
export function assignNodesToModules(nodes: Node[], moduleDirs: string[]): ModuleAssignment {
  // Longest dir first so nested modules take precedence over their parents.
  const dirsByLength = [...new Set(moduleDirs)]
    .filter((d) => d && d !== '.')
    .sort((a, b) => b.length - a.length);

  const fileToModuleDir = new Map<string, string>();
  const resolveFile = (filePath: string): string | undefined => {
    const cached = fileToModuleDir.get(filePath);
    if (cached !== undefined) return cached;
    const match = dirsByLength.find(
      (dir) => filePath === dir || filePath.startsWith(`${dir}/`)
    );
    if (match !== undefined) fileToModuleDir.set(filePath, match);
    return match;
  };

  const nodeToModuleDir = new Map<string, string>();
  const moduleToNodeIds = new Map<string, Set<string>>();
  let unassigned = 0;

  for (const node of nodes) {
    const dir = resolveFile(node.filePath);
    if (dir === undefined) {
      unassigned++;
      continue;
    }
    nodeToModuleDir.set(node.id, dir);
    let bucket = moduleToNodeIds.get(dir);
    if (!bucket) {
      bucket = new Set<string>();
      moduleToNodeIds.set(dir, bucket);
    }
    bucket.add(node.id);
  }

  return { nodeToModuleDir, moduleToNodeIds, fileToModuleDir, unassigned };
}
