/**
 * Where the migration layer keeps its artifacts. Kept separate from
 * `.codegraph/` so the two graphs never share storage: the code-symbol graph is
 * a derived cache, the migration graph is a committed deliverable.
 */

import { join } from 'node:path';

/** Per-project migration data directory (holds the graph JSON + generated code). */
export function getMigrationDir(projectRoot: string): string {
  return join(projectRoot, '.migration');
}

/** Root under which `migrate plan` writes plan.json + per-unit briefs. */
export function getPlanDir(projectRoot: string): string {
  return join(getMigrationDir(projectRoot), 'plan');
}

/** The migration ledger — per-unit migration status the agent registers via CLI. */
export function getLedgerPath(projectRoot: string): string {
  return join(getMigrationDir(projectRoot), 'ledger.json');
}

/** Directory holding per-unit `verify --unit` reports. */
export function getVerifyUnitsDir(projectRoot: string): string {
  return join(getMigrationDir(projectRoot), 'verify', 'units');
}
