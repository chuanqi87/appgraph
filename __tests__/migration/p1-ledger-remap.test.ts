/**
 * P1-5 · ledger reconciliation across a re-pack.
 *
 * Unit ids are content-derived, so re-packing the plan (merge/split/module
 * churn) changes them and orphans the ledger. computeLedgerRemap maps each
 * orphan to the new unit that best covers its modules; applyLedgerRemap carries
 * the status forward. Nothing is ever dropped silently — an unmatchable orphan
 * is reported.
 */

import { describe, it, expect } from 'vitest';
import { computeLedgerRemap, applyLedgerRemap } from '../../src/migration/plan/ledger-remap';
import { MigrationPlan, UnitPlan } from '../../src/migration/plan';
import { Ledger } from '../../src/migration/ledger';

function unit(id: string, label: string, moduleIds: string[], extra: Partial<UnitPlan> = {}): UnitPlan {
  return {
    id,
    order: 0,
    label,
    kind: 'module',
    cyclic: false,
    moduleIds,
    symbolCount: 0,
    wave: 0,
    dependsOnUnitIds: [],
    briefFile: `units/${id}.md`,
    contractFile: `contracts/${id}.json`,
    modules: [],
    ...extra,
  };
}

function plan(units: UnitPlan[]): MigrationPlan {
  return {
    schemaVersion: 4,
    source: { platform: 'android', app: { name: 'x', packageName: 'x' } },
    target: { platform: 'harmony' },
    planning: { enabled: true, minUnitSymbols: 120, maxUnitSymbols: 3000, merged: 0, split: 0 },
    totalUnits: units.length,
    units,
    appScaffold: { briefFile: 'units/00.md', contractFile: 'contracts/00.json' },
  };
}

function ledger(entries: Record<string, string>): Ledger {
  const units: Ledger['units'] = {};
  for (const [id, status] of Object.entries(entries)) {
    units[id] = { status: status as never, updatedAt: '2026-01-01T00:00:00.000Z' };
  }
  return { schemaVersion: 1, units };
}

describe('P1-5 · computeLedgerRemap', () => {
  it('maps two small units merged into one, keeping the more-advanced status', () => {
    const old = plan([unit('a', ':core:model', ['mMod']), unit('b', ':core:common', ['mCom'])]);
    // Re-pack merged both into one unit with a new id.
    const neu = plan([unit('m', ':core:common,:core:model', ['mCom', 'mMod'], { kind: 'merged' })]);
    const led = ledger({ a: 'migrated', b: 'in-progress' });

    const remap = computeLedgerRemap(old, neu, led);
    expect(remap.unmatched).toHaveLength(0);
    expect(remap.entries.map((e) => [e.fromLabel, e.toLabel, e.reason])).toEqual([
      [':core:common', ':core:common,:core:model', 'module-overlap'],
      [':core:model', ':core:common,:core:model', 'module-overlap'],
    ]);

    const moved = applyLedgerRemap(led, remap);
    expect(moved).toBe(2);
    expect(led.units.a).toBeUndefined();
    expect(led.units.b).toBeUndefined();
    // migrated (from a) beats in-progress (from b).
    expect(led.units.m!.status).toBe('migrated');
  });

  it('maps a former split slice back onto the whole module when it stops being split', () => {
    // Old plan split :app into slices; new plan keeps :app whole (one unit).
    const old = plan([
      unit('s1', ':app#feed', ['mApp'], { kind: 'split', featureSig: 'feed' }),
      unit('s2', ':app#rest', ['mApp'], { kind: 'split', featureSig: 'rest' }),
    ]);
    const neu = plan([unit('whole', ':app', ['mApp'], { kind: 'module' })]);
    const led = ledger({ s1: 'verified', s2: 'in-progress' });

    const remap = computeLedgerRemap(old, neu, led);
    expect(remap.unmatched).toHaveLength(0);
    // Both slices map to the whole module by full module overlap.
    expect(remap.entries.every((e) => e.toLabel === ':app' && e.reason === 'module-overlap')).toBe(true);
    applyLedgerRemap(led, remap);
    // verified (from s1) beats in-progress (from s2).
    expect(led.units.whole!.status).toBe('verified');
  });

  it('reports an orphan with no module overlap instead of dropping it', () => {
    const old = plan([unit('gone', ':legacy', ['mLegacy'])]);
    const neu = plan([unit('other', ':core:data', ['mData'])]);
    const led = ledger({ gone: 'migrated' });

    const remap = computeLedgerRemap(old, neu, led);
    expect(remap.entries).toHaveLength(0);
    expect(remap.unmatched).toEqual([
      { fromUnitId: 'gone', fromLabel: ':legacy', status: 'migrated', reason: 'no-overlap' },
    ]);
    // Apply leaves the orphan untouched (still visible).
    applyLedgerRemap(led, remap);
    expect(led.units.gone!.status).toBe('migrated');
  });

  it('leaves in-plan and scaffold entries alone', () => {
    const neu = plan([unit('keep', ':core:data', ['mData'])]);
    const led = ledger({ keep: 'migrated', 'app-scaffold': 'migrated' });
    const remap = computeLedgerRemap(neu, neu, led);
    expect(remap.entries).toHaveLength(0);
    expect(remap.unmatched).toHaveLength(0);
  });

  it('flags old-unit-unknown when there is no prior plan to interpret the id', () => {
    const neu = plan([unit('keep', ':core:data', ['mData'])]);
    const led = ledger({ ghost: 'in-progress' });
    const remap = computeLedgerRemap(null, neu, led);
    expect(remap.unmatched).toEqual([
      { fromUnitId: 'ghost', fromLabel: 'ghost', status: 'in-progress', reason: 'old-unit-unknown' },
    ]);
  });
});
