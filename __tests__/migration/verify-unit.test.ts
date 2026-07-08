/**
 * M4 · per-unit acceptance gate + three-way gap classification.
 *
 * Locks: a miss on a NOT-yet-migrated unit is `not-migrated` (not a gap); a miss
 * on a migrated unit is `unit-missing` (a real gap); a nav-edge to a screen owned
 * by a different, un-migrated unit is `dependency-missing`; and the report is
 * byte-identical across two runs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyMigrationGraph, mergeInto, MigrationGraph } from '../../src/migration/types';
import { AppNode, AppEdge, makeNodeId, makeEdgeId } from '../../src/appgraph/schema';
import { MigrationPlan } from '../../src/migration/plan';
import { UnitContract } from '../../src/migration/plan/contract';
import { Ledger, LedgerStatus } from '../../src/migration/ledger';
import { verifyUnit } from '../../src/migration/verify/unit';
import { canonicalJson } from '../../src/appgraph/serialize';

const MOD_A = 'modA';
const MOD_B = 'modB';

let target = '';
beforeEach(() => {
  target = mkdtempSync(join(tmpdir(), 'vunit-'));
  mkdirSync(join(target, 'entry/src/main/ets'), { recursive: true });
  // Target has ScreenA but NOT ScreenB, and does NOT carry the BASE_URL literal.
  writeFileSync(join(target, 'entry/src/main/ets/ScreenA.ets'), '@Entry\n@Component\nstruct ScreenA {}\n');
});
afterEach(() => rmSync(target, { recursive: true, force: true }));

function graph(): MigrationGraph {
  const g = emptyMigrationGraph({ platform: 'android', app: { name: 't', packageName: 'c' } });
  const sA = screen('ScreenA', MOD_A);
  const sB = screen('ScreenB', MOD_B);
  const nodes: AppNode[] = [sA, sB];
  const edges: AppEdge[] = [
    edge('app_contains', MOD_A, sA.id),
    edge('app_contains', MOD_B, sB.id),
  ];
  mergeInto(g, { nodes, edges });
  return g;
}

function screen(name: string, _mod: string): AppNode {
  return {
    id: makeNodeId('android', 'Screen', `screen:${name}`),
    kind: 'Screen',
    matchKey: `screen:${name}`,
    name,
    platform: 'android',
    provenance: 'source-static',
    fidelity: 'source-project',
    confidence: 1,
  };
}
function edge(kind: AppEdge['kind'], from: string, to: string): AppEdge {
  return { id: makeEdgeId(kind, from, to), kind, from, to, provenance: 'source-static', confidence: 1 };
}

function plan(): MigrationPlan {
  const unit = (id: string, order: number, moduleId: string) => ({
    id, order, label: id, kind: 'module' as const, cyclic: false, moduleIds: [moduleId],
    symbolCount: 0, briefFile: '', contractFile: '', modules: [],
  });
  return {
    schemaVersion: 3,
    source: { platform: 'android', app: { name: 't', packageName: 'c' } },
    target: undefined,
    planning: { enabled: true, minUnitSymbols: 120, maxUnitSymbols: 3000, merged: 0, split: 0 },
    totalUnits: 2,
    units: [unit('unitA', 0, MOD_A), unit('unitB', 1, MOD_B)],
  } as unknown as MigrationPlan;
}

/** unitA's contract: one constant (own fact) + one nav-edge to ScreenB (dep fact). */
function contract(): UnitContract {
  return {
    schemaVersion: 1,
    unitId: 'unitA',
    unitLabel: 'unitA',
    checks: [
      {
        id: 'c1', tier: 'L3', kind: 'constant', moduleId: MOD_A, moduleName: 'A',
        subject: 'BASE_URL=https://api.example.com', expect: '', verify: 'auto', depth: 'contains-scan',
        params: { value: 'https://api.example.com' },
      },
      {
        id: 'c2', tier: 'L2', kind: 'nav-edge', moduleId: MOD_A, moduleName: 'A',
        subject: 'ScreenA->ScreenB', expect: '', verify: 'auto', depth: 'name-only',
        params: { from: 'ScreenA', to: 'ScreenB' },
      },
    ],
  };
}

function ledger(units: Record<string, LedgerStatus>): Ledger {
  const out: Ledger = { schemaVersion: 1, units: {} };
  for (const [id, status] of Object.entries(units)) out.units[id] = { status, updatedAt: '2026-01-01T00:00:00Z' };
  return out;
}

describe('verifyUnit · three-way classification', () => {
  it('classifies a miss on a NOT-migrated unit as not-migrated (no gap)', async () => {
    const report = await verifyUnit(graph(), plan(), contract(), target, null);
    const constant = report.checks.find((c) => c.kind === 'constant')!;
    expect(constant.status).toBe('skipped');
    expect(constant.gapClass).toBe('not-migrated');
  });

  it('classifies a miss on a MIGRATED unit as unit-missing (real gap)', async () => {
    const report = await verifyUnit(graph(), plan(), contract(), target, ledger({ unitA: 'migrated' }));
    const constant = report.checks.find((c) => c.kind === 'constant')!;
    expect(constant.status).toBe('fail');
    expect(constant.gapClass).toBe('unit-missing');
    expect(constant.evidence ?? []).toEqual([]); // literal absent → no hit files
  });

  it('classifies a nav-edge into an un-migrated dependency as dependency-missing', async () => {
    // unitA migrated, but ScreenB's owner unitB is still pending.
    const report = await verifyUnit(graph(), plan(), contract(), target, ledger({ unitA: 'migrated', unitB: 'pending' }));
    const nav = report.checks.find((c) => c.kind === 'nav-edge')!;
    expect(nav.status).toBe('skipped');
    expect(nav.gapClass).toBe('dependency-missing');
  });

  it('passes a check whose invariant is present on the target', async () => {
    writeFileSync(join(target, 'entry/src/main/ets/net.ts'), "const u = 'https://api.example.com';\n");
    const report = await verifyUnit(graph(), plan(), contract(), target, ledger({ unitA: 'migrated' }));
    expect(report.checks.find((c) => c.kind === 'constant')!.status).toBe('pass');
  });

  it('produces a byte-identical report across two runs', async () => {
    const a = canonicalJson(await verifyUnit(graph(), plan(), contract(), target, ledger({ unitA: 'migrated' })));
    const b = canonicalJson(await verifyUnit(graph(), plan(), contract(), target, ledger({ unitA: 'migrated' })));
    expect(a).toBe(b);
  });
});
