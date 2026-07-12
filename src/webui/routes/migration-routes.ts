/**
 * /api/migration/* — reads the already-built `.migration/migration-graph.json`
 * and `.migration/ledger.json`, serving them to the UI. The migration graph is
 * a superset of AppGraph (same node/edge shapes) plus a bottom-up migration
 * order (SCC units) and a per-unit progress ledger.
 *
 * Mirrors appgraph-routes.ts's read-only, small-document, no-pagination
 * pattern — the whole graph is served in one call. Returns `graph: null`
 * (success-shaped) when no migration graph exists yet, mirroring the ledger
 * route, so the client can render guidance instead of erroring.
 */

import { readMigrationGraph, migrationGraphPath } from '../../migration/serialize';
import { readLedger } from '../../migration/ledger';
import { getLedgerPath } from '../../migration/paths';
import { Router } from '../router';

export function registerMigrationRoutes(router: Router, root: string): void {
  router.get('/api/migration/graph', () => {
    const graph = readMigrationGraph(migrationGraphPath(root));
    return { body: { graph: graph ?? null } };
  });

  router.get('/api/migration/ledger', () => {
    const ledger = readLedger(getLedgerPath(root));
    return { body: { ledger: ledger ?? null } };
  });
}
