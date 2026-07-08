/**
 * Where the AppGraph layer keeps its artifact. Kept separate from `.codegraph/`
 * (a derived code-symbol cache) and `.migration/` (the migration deliverable):
 * `.appgraph/app-graph.json` is the platform-neutral application knowledge graph
 * that a source OR a target project can each build on its own.
 */

import { join } from 'node:path';

/** Per-project AppGraph data directory. */
export function getAppGraphDir(projectRoot: string): string {
  return join(projectRoot, '.appgraph');
}

/** Default on-disk path for a project's app graph. */
export function appGraphPath(projectRoot: string): string {
  return join(getAppGraphDir(projectRoot), 'app-graph.json');
}
