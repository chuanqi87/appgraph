/**
 * P1-5 · ledger reconciliation across a re-pack.
 *
 * Unit ids are content-derived (sorted member module ids, plus the feature sig
 * for split slices), so re-packing the plan — merging small units, splitting a
 * grown module, a module gaining/losing code — changes ids. A ledger keyed by
 * the OLD ids then has "orphan" entries the new plan can't see, and the agent's
 * migration progress silently drops out of every readiness/verify view.
 *
 * This maps each orphaned ledger unit to the new unit that best covers its
 * source modules, so `migrate ledger remap --apply` can carry the recorded
 * status forward. It NEVER drops an orphan silently: an unmatched one is
 * reported as such, for the human to resolve.
 *
 * Pure: the mapping is a deterministic function of (old plan, new plan, ledger).
 */

import { MigrationPlan, UnitPlan } from './index';
import { Ledger } from '../ledger';

/** A resolved mapping from one orphaned ledger unit to a new plan unit. */
export interface RemapEntry {
  fromUnitId: string;
  fromLabel: string;
  status: string;
  toUnitId: string;
  toLabel: string;
  /** How the new unit was chosen (identical members, or best module overlap). */
  reason: 'exact' | 'module-overlap';
  /** Fraction of the orphan's modules the new unit covers, in [0,1]. */
  coverage: number;
}

/** An orphaned ledger unit with no defensible new home. */
export interface UnmatchedEntry {
  fromUnitId: string;
  fromLabel: string;
  status: string;
  /** Why nothing matched (old unit unknown, or no new unit shares its modules). */
  reason: 'old-unit-unknown' | 'no-overlap';
}

export interface LedgerRemap {
  /** Resolved remappings, sorted by source label. */
  entries: RemapEntry[];
  /** Orphans left unresolved (surfaced, never dropped). */
  unmatched: UnmatchedEntry[];
}

/**
 * Compute the reconciliation map. `oldPlan` may be null (no prior plan on disk),
 * in which case every non-plan ledger unit is unmatchable (old-unit-unknown).
 */
export function computeLedgerRemap(
  oldPlan: MigrationPlan | null,
  newPlan: MigrationPlan,
  ledger: Ledger
): LedgerRemap {
  const newIds = new Set(newPlan.units.map((u) => u.id));
  const oldById = new Map((oldPlan?.units ?? []).map((u) => [u.id, u]));

  const entries: RemapEntry[] = [];
  const unmatched: UnmatchedEntry[] = [];

  for (const [ledgerUnitId, entry] of Object.entries(ledger.units)) {
    // Still in the new plan (or the cross-unit scaffold) — nothing to remap.
    if (newIds.has(ledgerUnitId) || ledgerUnitId === 'app-scaffold') continue;

    const old = oldById.get(ledgerUnitId);
    if (!old) {
      unmatched.push({ fromUnitId: ledgerUnitId, fromLabel: ledgerUnitId, status: entry.status, reason: 'old-unit-unknown' });
      continue;
    }

    const match = bestMatch(old, newPlan.units);
    if (!match) {
      unmatched.push({ fromUnitId: ledgerUnitId, fromLabel: old.label, status: entry.status, reason: 'no-overlap' });
      continue;
    }
    entries.push({
      fromUnitId: ledgerUnitId,
      fromLabel: old.label,
      status: entry.status,
      toUnitId: match.unit.id,
      toLabel: match.unit.label,
      reason: match.reason,
      coverage: match.coverage,
    });
  }

  entries.sort((a, b) => a.fromLabel.localeCompare(b.fromLabel));
  unmatched.sort((a, b) => a.fromLabel.localeCompare(b.fromLabel));
  return { entries, unmatched };
}

/**
 * Apply a remap to a ledger IN PLACE: move each orphan entry to its new unit id
 * and drop the old key. When two orphans map to the same new unit (a merge),
 * the more-advanced status wins so progress is never lost. Returns the count of
 * entries moved. Unmatched orphans are left untouched (still visible as orphans).
 */
export function applyLedgerRemap(ledger: Ledger, remap: LedgerRemap): number {
  // Rank so a merge keeps the furthest-along status.
  const rank: Record<string, number> = {
    pending: 0,
    blocked: 1,
    'in-progress': 2,
    migrated: 3,
    verified: 4,
  };
  let moved = 0;
  for (const e of remap.entries) {
    const src = ledger.units[e.fromUnitId];
    if (!src) continue;
    const existing = ledger.units[e.toUnitId];
    if (!existing || (rank[src.status] ?? 0) > (rank[existing.status] ?? 0)) {
      ledger.units[e.toUnitId] = { ...src, updatedAt: new Date().toISOString() };
    }
    delete ledger.units[e.fromUnitId];
    moved++;
  }
  return moved;
}

interface Candidate {
  unit: UnitPlan;
  reason: RemapEntry['reason'];
  coverage: number;
}

/**
 * Pick the new unit that best covers an orphan's source modules. Priority:
 *   1. exact — identical module set AND same featureSig (a stable re-pack of a
 *      renamed/re-ordered unit; a split slice's id already folds featureSig, so
 *      an unchanged slice lands here).
 *   2. module-overlap — the new unit covering the most of the orphan's modules
 *      (ties broken by fewest extra modules, then label). Any positive overlap
 *      qualifies; zero overlap returns null (reported unmatched, never guessed).
 */
function bestMatch(old: UnitPlan, newUnits: UnitPlan[]): Candidate | null {
  const oldMods = new Set(old.moduleIds);
  const sameSet = (u: UnitPlan): boolean =>
    u.moduleIds.length === oldMods.size && u.moduleIds.every((m) => oldMods.has(m));

  // 1. exact member + featureSig identity.
  const exact = newUnits.find((u) => sameSet(u) && u.featureSig === old.featureSig);
  if (exact) return { unit: exact, reason: 'exact', coverage: 1 };

  // 2. maximum module overlap: most of the orphan's modules covered, ties broken
  // by fewest extra (unrelated) modules, then by label — a total order.
  let best: Candidate | null = null;
  let bestExtra = Infinity;
  for (const u of newUnits) {
    const overlap = u.moduleIds.filter((m) => oldMods.has(m)).length;
    if (overlap === 0) continue;
    const coverage = overlap / oldMods.size;
    const extra = u.moduleIds.length - overlap;
    const better =
      best === null ||
      coverage > best.coverage ||
      (coverage === best.coverage && extra < bestExtra) ||
      (coverage === best.coverage && extra === bestExtra && u.label.localeCompare(best.unit.label) < 0);
    if (better) {
      best = { unit: u, reason: 'module-overlap', coverage };
      bestExtra = extra;
    }
  }
  return best;
}
