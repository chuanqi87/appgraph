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

/** Ledger reconciliation map written by `migrate plan` when re-packing orphaned
 *  ledger units — consumed by `migrate ledger remap --apply`. */
export function getLedgerRemapPath(projectRoot: string): string {
  return join(getMigrationDir(projectRoot), 'ledger-remap.json');
}

/** LLM semantic labels sidecar (P1-3b) — Feature/unit names + descriptions the
 *  calling agent writes back through `migrate_label`. Kept out of the graph so
 *  the deterministic fingerprint is unaffected. */
export function getLabelsPath(projectRoot: string): string {
  return join(getMigrationDir(projectRoot), 'labels.json');
}
