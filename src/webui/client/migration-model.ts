/**
 * Client-side derived model over a MigrationGraph document + its ledger.
 *
 * Mirrors appgraph-model.ts's pattern: the whole graph is small, so every
 * "which unit contains which module / what depends on what / what's the
 * migration status of this unit" lookup is pre-indexed once per view mount.
 *
 * The MigrationGraph is a SUPERSET of AppGraph (same AppNode/AppEdge shapes)
 * plus a bottom-up `order` (SCC units) and a per-unit `ledger` (progress).
 * This model layers those two on top of the AppGraph indices by reusing
 * buildAppGraphModel for the shared node/edge indices, then adding
 * migration-specific ones (units, waves, ledger lookups, progress stats).
 *
 * Pure + framework-free: takes the wire graph + wire ledger, returns indices.
 * No DOM.
 */

import {
  buildAppGraphModel,
  type AppGraphModel,
} from './appgraph-model';
import type {
  AppGraphWire,
  LedgerEntryWire,
  LedgerStatusWire,
  LedgerWire,
  MigrationGraphWire,
  MigrationUnitWire,
} from '../wire-types';

export interface MigrationModel {
  /** The underlying AppGraph model — provides byId, outByNode, modules, etc. */
  appModel: AppGraphModel;
  graph: MigrationGraphWire;
  ledger: LedgerWire | null;

  /** Units sorted by bottom-up order (order field, 0 = leaf-first). */
  units: MigrationUnitWire[];
  /** Unit by id. */
  unitById: Map<string, MigrationUnitWire>;
  /** Module node id → unit id (which unit owns a module). */
  moduleToUnit: Map<string, string>;
  /** Units grouped by parallel wave (wave → units in that wave, sorted by order). */
  unitsByWave: Map<number, MigrationUnitWire[]>;
  /** Max wave index (0-based); -1 if no order. */
  maxWave: number;
  /** Units with necessity 'dev-only'. */
  devOnlyUnitIds: Set<string>;

  /** Ledger entry by unit id (null when no ledger or unit not registered). */
  ledgerByUnit: Map<string, LedgerEntryWire>;
  /** Counts per status across all units (absent = 'pending' implicitly). */
  statusCounts: Record<LedgerStatusWire, number>;
  /** Total units in the order (denominator for progress %). */
  totalUnits: number;
  /** How many units are fully done (verified). */
  completed: number;
}

export function buildMigrationModel(
  graph: MigrationGraphWire,
  ledger: LedgerWire | null
): MigrationModel {
  const appWire: AppGraphWire = {
    schemaVersion: graph.schemaVersion,
    platform: graph.source.platform,
    app: graph.source.app,
    fidelity: 'source-project',
    supportedKinds: [],
    nodes: graph.nodes,
    edges: graph.edges,
    coverageWarnings: graph.coverageWarnings,
    navFrameworks: graph.navFrameworks ?? [],
  };
  const appModel = buildAppGraphModel(appWire);

  const units = graph.order?.units ?? [];
  units.sort((a, b) => a.order - b.order);

  const unitById = new Map<string, MigrationUnitWire>();
  const moduleToUnit = new Map<string, string>();
  const unitsByWave = new Map<number, MigrationUnitWire[]>();
  const devOnlyUnitIds = new Set<string>();
  let maxWave = -1;

  for (const u of units) {
    unitById.set(u.id, u);
    for (const modId of u.moduleIds) {
      moduleToUnit.set(modId, u.id);
    }
    if (u.wave !== undefined) {
      maxWave = Math.max(maxWave, u.wave);
      const arr = unitsByWave.get(u.wave) ?? [];
      arr.push(u);
      unitsByWave.set(u.wave, arr);
    }
    if (u.necessity === 'dev-only') {
      devOnlyUnitIds.add(u.id);
    }
  }

  const ledgerByUnit = new Map<string, LedgerEntryWire>();
  if (ledger) {
    for (const [unitId, entry] of Object.entries(ledger.units)) {
      ledgerByUnit.set(unitId, entry);
    }
  }

  const statusCounts: Record<LedgerStatusWire, number> = {
    pending: 0,
    'in-progress': 0,
    migrated: 0,
    verified: 0,
    blocked: 0,
  };
  for (const u of units) {
    const entry = ledgerByUnit.get(u.id);
    const status = entry?.status ?? 'pending';
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  }

  return {
    appModel,
    graph,
    ledger,
    units,
    unitById,
    moduleToUnit,
    unitsByWave,
    maxWave,
    devOnlyUnitIds,
    ledgerByUnit,
    statusCounts,
    totalUnits: units.length,
    completed: statusCounts.verified,
  };
}

/** The ledger entry for a unit (null if no ledger or not registered). */
export function unitLedgerEntry(
  model: MigrationModel,
  unitId: string
): LedgerEntryWire | null {
  return model.ledgerByUnit.get(unitId) ?? null;
}

/** The effective status of a unit: ledger entry's status, or 'pending'. */
export function unitStatus(model: MigrationModel, unitId: string): LedgerStatusWire {
  return model.ledgerByUnit.get(unitId)?.status ?? 'pending';
}

/** All units a given unit depends on (must migrate first). */
export function unitDependencies(
  model: MigrationModel,
  unitId: string
): MigrationUnitWire[] {
  const unit = model.unitById.get(unitId);
  if (!unit?.dependsOn) return [];
  return unit.dependsOn
    .map((id) => model.unitById.get(id))
    .filter((u): u is MigrationUnitWire => u !== undefined);
}

/** All units that depend on the given unit. */
export function unitDependents(
  model: MigrationModel,
  unitId: string
): MigrationUnitWire[] {
  return model.units.filter((u) => u.dependsOn?.includes(unitId));
}

/** The module nodes (AppNodeWire) that belong to a unit. */
export function unitModules(
  model: MigrationModel,
  unitId: string
): AppGraphWire['nodes'] {
  const unit = model.unitById.get(unitId);
  if (!unit) return [];
  return unit.moduleIds
    .map((id) => model.appModel.byId.get(id))
    .filter((n): n is NonNullable<typeof n> => n !== undefined);
}
