/**
 * Migration ledger — the per-unit progress record.
 *
 * Locks the state-machine (every legal/illegal transition cell + same-status
 * updates), the empty-ledger shape, on-disk round-trip, and canonical
 * byte-stability (the ledger is runtime state but must stay diffable).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertTransition,
  emptyLedger,
  Ledger,
  LedgerStatus,
  readLedger,
  writeLedger,
} from '../../src/migration/ledger';

const STATUSES: LedgerStatus[] = ['pending', 'in-progress', 'migrated', 'verified', 'blocked'];
const LEGAL: Record<string, LedgerStatus[]> = {
  none: ['pending', 'in-progress', 'migrated', 'blocked'],
  pending: ['in-progress', 'blocked'],
  'in-progress': ['pending', 'migrated', 'blocked'],
  migrated: ['in-progress', 'verified', 'blocked'],
  verified: ['in-progress', 'blocked'],
  blocked: ['pending', 'in-progress'],
};

describe('assertTransition', () => {
  it('accepts exactly the legal transitions per current status', () => {
    for (const [fromKey, allowed] of Object.entries(LEGAL)) {
      const from = fromKey === 'none' ? null : (fromKey as LedgerStatus);
      for (const to of STATUSES) {
        const legal = allowed.includes(to) || from === to; // same-status always ok
        if (legal) {
          expect(() => assertTransition(from, to)).not.toThrow();
        } else {
          expect(() => assertTransition(from, to)).toThrow();
        }
      }
    }
  });

  it('allows a same-status update and lists legal options on violation', () => {
    expect(() => assertTransition('verified', 'verified')).not.toThrow();
    expect(() => assertTransition('pending', 'verified')).toThrow(/in-progress, blocked/);
  });
});

describe('ledger persistence', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('round-trips and is byte-identical across two writes', () => {
    const ledger: Ledger = emptyLedger();
    ledger.units['u2'] = { status: 'migrated', targetModule: 'entry', updatedAt: '2026-01-01T00:00:00Z' };
    ledger.units['u1'] = {
      status: 'verified',
      targetPaths: ['entry/src', 'feature/src'],
      exportMap: { Foo: 'FooPage' },
      updatedAt: '2026-01-02T00:00:00Z',
    };

    const path = join(dir, 'ledger.json');
    writeLedger(path, ledger);
    const raw1 = readFileSync(path, 'utf8');
    writeLedger(path, ledger);
    const raw2 = readFileSync(path, 'utf8');
    expect(raw1).toBe(raw2);
    // Canonical: keys sorted, so u1 precedes u2 regardless of insertion order.
    expect(raw1.indexOf('"u1"')).toBeLessThan(raw1.indexOf('"u2"'));

    const loaded = readLedger(path)!;
    expect(loaded.units['u1']!.exportMap).toEqual({ Foo: 'FooPage' });
    expect(loaded.units['u2']!.targetModule).toBe('entry');
  });

  it('returns null when no ledger exists', () => {
    expect(readLedger(join(dir, 'absent.json'))).toBeNull();
  });
});
