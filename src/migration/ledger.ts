/**
 * Migration ledger — the per-unit progress record an external agent maintains
 * as it works through the plan.
 *
 * appgraph does NOT translate; the agent does, and it REGISTERS what it did via
 * `migrate ledger set` (never by hand-editing this JSON). The ledger then feeds
 * two consumers: `verify --unit` uses a unit's status to classify a failing
 * check (a real gap vs. "not migrated yet"), and it uses `targetPaths` to scope
 * the target scan and `exportMap` to match renamed exports. The ledger is
 * runtime state — it carries timestamps and does NOT participate in the graph
 * fingerprint — but every write goes through `canonicalJson` so it stays
 * diffable.
 *
 * The ledger records what the agent CLAIMS; it does not verify those claims
 * (a non-existent `targetPath` degrades scope with a warning, it doesn't error).
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson } from './serialize';

export const LEDGER_SCHEMA_VERSION = 1;

export type LedgerStatus = 'pending' | 'in-progress' | 'migrated' | 'verified' | 'blocked';

export interface LedgerEntry {
  status: LedgerStatus;
  /** Target HarmonyOS module name (e.g. "entry"). */
  targetModule?: string;
  /** Target-root-relative path prefixes (POSIX), sorted — the per-unit scope. */
  targetPaths?: string[];
  /** Source export name → target export name (only renamed members). */
  exportMap?: Record<string, string>;
  notes?: string;
  /** ISO timestamp; runtime state, excluded from the two-run byte contract. */
  updatedAt: string;
}

export interface Ledger {
  schemaVersion: number;
  units: Record<string, LedgerEntry>;
}

/** Legal next statuses per current status (null = no entry yet). */
const TRANSITIONS: Record<LedgerStatus | 'none', LedgerStatus[]> = {
  none: ['pending', 'in-progress', 'migrated', 'blocked'],
  pending: ['in-progress', 'blocked'],
  'in-progress': ['pending', 'migrated', 'blocked'],
  migrated: ['in-progress', 'verified', 'blocked'],
  verified: ['in-progress', 'blocked'],
  blocked: ['pending', 'in-progress'],
};

/** An empty ledger (no units registered). */
export function emptyLedger(): Ledger {
  return { schemaVersion: LEDGER_SCHEMA_VERSION, units: {} };
}

/** Load the ledger, or null if none has been written yet. */
export function readLedger(path: string): Ledger | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  return JSON.parse(raw) as Ledger;
}

/** Persist the ledger (canonical JSON so it stays diffable). */
export function writeLedger(path: string, ledger: Ledger): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, canonicalJson(ledger) + '\n', 'utf8');
}

/**
 * Assert a status transition is legal; throw (listing the legal options) if not.
 * A same-status update (e.g. revising notes) is always allowed.
 */
export function assertTransition(from: LedgerStatus | null, to: LedgerStatus): void {
  if (from === to) return;
  const legal = TRANSITIONS[from ?? 'none'];
  if (!legal.includes(to)) {
    const current = from ?? '(未登记)';
    throw new Error(`非法状态迁移 ${current} → ${to};合法目标:${legal.join(', ')}`);
  }
}
