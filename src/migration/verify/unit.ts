/**
 * M4 · per-UNIT acceptance gate.
 *
 * The full-project `verify` answers "is the whole app migrated?"; a migration
 * agent working unit N needs "is UNIT N migrated?" without the other N-1 units'
 * gaps drowning the signal. `verifyUnit` runs one unit's contract checks against
 * the target and classifies every miss into one of three buckets:
 *
 *   - unit-missing        — the ledger says this unit is migrated/verified, yet
 *                           the invariant is absent → a REAL gap to fix.
 *   - not-migrated        — this unit isn't done yet → not a gap, just pending.
 *   - dependency-missing  — the invariant references a fact owned by a DIFFERENT
 *                           unit that isn't migrated yet → blocked on a dep.
 *
 * agent/info checks (background, test, state, unverifiable capabilities) are
 * listed as obligations and NEVER auto-fail. The report is pure over its inputs
 * (it reads the target dir but returns the report; the CLI persists it), and
 * canonical so findings stay diffable across rounds by stable check id.
 */

import { AppNode } from '../schema';
import { MigrationGraph } from '../types';
import { ContractCheck, UnitContract } from '../plan/contract';
import { MigrationPlan } from '../plan';
import { Ledger, LedgerStatus } from '../ledger';
import { ArkExport, resolveTargetSurface } from './target-graph';
import { diffEntitySchemas, normalizeScreenName } from './structure-diff';
import {
  loadTargetSources,
  scanEnumValues,
  scanLiteral,
  scanSql,
  TargetSourceIndex,
} from './semantic-scan';
import {
  countInterfaceNames,
  matchInterface,
  RenameMaps,
  splitRenameMaps,
} from './interface-match';

export type GapClass = 'unit-missing' | 'dependency-missing' | 'not-migrated';

export interface CheckResult {
  id: string;
  tier: ContractCheck['tier'];
  kind: ContractCheck['kind'];
  moduleName: string;
  subject: string;
  status: 'pass' | 'fail' | 'skipped' | 'info';
  /** Only on fail/skipped. */
  gapClass?: GapClass;
  /** Missing names / hit files — sorted, deduped, capped at 20. */
  evidence?: string[];
  /** The depth actually reached. */
  depth?: string;
}

export interface UnitVerifyReport {
  schemaVersion: 1;
  unitId: string;
  unitLabel: string;
  method: 'codegraph';
  scope: 'ledger-paths' | 'module-path' | 'global';
  checks: CheckResult[];
  summary: { total: number; pass: number; fail: number; skipped: number; info: number };
}

/** A ledger status counts as "done" (a subsequent miss is a real gap). */
const MIGRATED_STATES = new Set<LedgerStatus>(['migrated', 'verified']);

/** Verify a single unit's contract against the migrated target project. */
export async function verifyUnit(
  graph: MigrationGraph,
  plan: MigrationPlan,
  contract: UnitContract,
  targetRoot: string,
  ledger: Ledger | null
): Promise<UnitVerifyReport> {
  const surface = await resolveTargetSurface(targetRoot);
  const entry = ledger?.units[contract.unitId];
  const unitStatus = entry?.status ?? null;
  const moduleNames = [...new Set(contract.checks.map((c) => c.moduleName))];

  // Scope descent: ledger targetPaths → module-name path guess → global.
  let scope: UnitVerifyReport['scope'];
  let index: TargetSourceIndex;
  let exports: ArkExport[];
  if (entry?.targetPaths && entry.targetPaths.length > 0) {
    scope = 'ledger-paths';
    index = loadTargetSources(targetRoot, entry.targetPaths);
    exports = scopeExportsByPrefix(surface.exports, entry.targetPaths);
  } else {
    const moduleScoped = scopeExportsByModuleName(surface.exports, moduleNames);
    if (moduleScoped.length > 0) {
      scope = 'module-path';
      index = loadTargetSources(targetRoot);
      exports = moduleScoped;
    } else {
      scope = 'global';
      index = loadTargetSources(targetRoot);
      exports = surface.exports;
    }
  }

  const exportMap = entry?.exportMap ?? {};
  const ctx: DispatchContext = {
    exports,
    exportNames: new Set(exports.map((e) => e.name.toLowerCase())),
    screenBases: new Set(surface.screenNodes.map((n) => normalizeScreenName(n.name))),
    navEdgeBases: new Set(
      surface.navEdges.map((e) => `${normalizeScreenName(e.from)} ${normalizeScreenName(e.to)}`)
    ),
    capabilityKeys: new Set(surface.capabilityNodes.map((n) => n.matchKey)),
    index,
    exportMap,
    renames: splitRenameMaps(exportMap),
    interfaceNameCounts: countInterfaceNames(contract.checks),
    screenToModule: screenNameToModuleId(graph),
    moduleToUnit: moduleIdToUnitId(plan),
    ledger,
    unitStatus,
    unitModuleIds: new Set(contract.checks.map((c) => c.moduleId)),
  };

  const checks = contract.checks.map((check) => evaluate(check, ctx));
  const summary = { total: checks.length, pass: 0, fail: 0, skipped: 0, info: 0 };
  for (const c of checks) summary[c.status]++;

  return {
    schemaVersion: 1,
    unitId: contract.unitId,
    unitLabel: contract.unitLabel,
    method: surface.method,
    scope,
    checks,
    summary,
  };
}

interface DispatchContext {
  exports: ArkExport[];
  exportNames: Set<string>;
  screenBases: Set<string>;
  navEdgeBases: Set<string>;
  capabilityKeys: Set<string>;
  index: TargetSourceIndex;
  /** Raw ledger renames (di-binding still matches by bare type name). */
  exportMap: Record<string, string>;
  /** Ledger renames split by key shape — interface matching disambiguates with these. */
  renames: RenameMaps;
  /** Lowercased simple name → how many interface checks share it (collision guard). */
  interfaceNameCounts: Map<string, number>;
  screenToModule: Map<string, string>;
  moduleToUnit: Map<string, string>;
  ledger: Ledger | null;
  unitStatus: LedgerStatus | null;
  unitModuleIds: Set<string>;
}

/** Evaluate one contract check against the target surface + scan index. */
function evaluate(check: ContractCheck, ctx: DispatchContext): CheckResult {
  const base: CheckResult = {
    id: check.id,
    tier: check.tier,
    kind: check.kind,
    moduleName: check.moduleName,
    subject: check.subject,
    status: 'info',
  };

  // agent/info checks are obligations — listed, never auto-failed.
  if (check.verify !== 'auto') return { ...base, status: 'info' };

  const outcome = runAuto(check, ctx);
  if (outcome.pass) {
    return { ...base, status: 'pass', ...(outcome.depth ? { depth: outcome.depth } : {}) };
  }
  return {
    ...base,
    status: gapStatus(check, ctx),
    gapClass: classify(check, ctx),
    ...(outcome.evidence && outcome.evidence.length > 0 ? { evidence: capEvidence(outcome.evidence) } : {}),
    ...(outcome.depth ? { depth: outcome.depth } : {}),
  };
}

interface AutoOutcome {
  pass: boolean;
  evidence?: string[];
  depth?: string;
}

/** Dispatch an auto check to its kind-specific comparison. */
function runAuto(check: ContractCheck, ctx: DispatchContext): AutoOutcome {
  const p = check.params ?? {};
  switch (check.kind) {
    case 'interface':
      return interfaceOutcome(check, ctx);
    case 'screen':
      return { pass: ctx.screenBases.has(normalizeScreenName(String(p.name))), depth: 'name-only' };
    case 'model':
      return modelOutcome(String(p.name), asStringArray(p.fields), ctx);
    case 'capability':
      return { pass: ctx.capabilityKeys.has(`capability:${String(p.capabilityId)}`), depth: 'contains-scan' };
    case 'di-binding': {
      const missing = [String(p.iface), String(p.impl)].filter((t) => !hasExport(t, ctx));
      return { pass: missing.length === 0, evidence: missing, depth: 'name-only' };
    }
    case 'nav-edge': {
      // Endpoint screens must exist AND the target must carry the router edge.
      const endpointsMissing = [String(p.from), String(p.to)]
        .filter((s) => !ctx.screenBases.has(normalizeScreenName(s)));
      if (endpointsMissing.length > 0) return { pass: false, evidence: endpointsMissing, depth: 'name-only' };
      const key = `${normalizeScreenName(String(p.from))} ${normalizeScreenName(String(p.to))}`;
      return { pass: ctx.navEdgeBases.has(key), evidence: [`${p.from}->${p.to}`], depth: 'name-only' };
    }
    case 'constant':
    case 'deeplink': {
      const value = String(check.kind === 'constant' ? p.value : p.deeplink);
      const hit = scanLiteral(ctx.index, value);
      return { pass: hit.hit, evidence: hit.files, depth: 'contains-scan' };
    }
    case 'route': {
      const hit = scanLiteral(ctx.index, String(p.path));
      return { pass: hit.hit, evidence: hit.files, depth: 'contains-scan' };
    }
    case 'query': {
      const hit = scanSql(ctx.index, String(p.sql));
      return { pass: hit.hit, evidence: hit.files, depth: 'contains-scan' };
    }
    case 'enum-values': {
      const { present, missing } = scanEnumValues(ctx.index, asStringArray(p.values));
      return { pass: missing.length === 0, evidence: missing.length > 0 ? missing : present, depth: 'set-compare' };
    }
    default:
      return { pass: false };
  }
}

/** A model's field-set fidelity, reusing `diffEntitySchemas` on a synthetic node. */
function modelOutcome(name: string, fields: string[], ctx: DispatchContext): AutoOutcome {
  const synthetic = { name, attrs: { fields: fields.map((f) => ({ name: f })) } } as unknown as AppNode;
  const diff = diffEntitySchemas([synthetic], ctx.exports);
  const m = diff.models[0];
  if (!m || !m.present) return { pass: false, evidence: fields, depth: 'absent' };
  const depth = m.fieldCheck === 'full' ? 'set-compare' : 'name-only';
  return { pass: m.missingFields.length === 0, evidence: m.missingFields, depth };
}

/** L1 interface check → the target surface (nested-type-aware; see interface-match). */
function interfaceOutcome(check: ContractCheck, ctx: DispatchContext): AutoOutcome {
  const m = matchInterface(check, {
    exportNames: ctx.exportNames,
    renames: ctx.renames,
    interfaceNameCounts: ctx.interfaceNameCounts,
  });
  return { pass: m.pass, evidence: m.evidence, depth: 'name-only' };
}

/** True when a source name (or its ledger-renamed target) is a target export. */
function hasExport(name: string, ctx: DispatchContext): boolean {
  if (ctx.exportNames.has(name.toLowerCase())) return true;
  const renamed = ctx.exportMap[name];
  return renamed !== undefined && ctx.exportNames.has(renamed.toLowerCase());
}

/** fail (unit's fault) vs skipped (not this unit's turn / blocked on a dep). */
function gapStatus(check: ContractCheck, ctx: DispatchContext): 'fail' | 'skipped' {
  if (classify(check, ctx) === 'unit-missing') return 'fail';
  return 'skipped';
}

/** Classify a failing auto check into the three gap buckets. */
function classify(check: ContractCheck, ctx: DispatchContext): GapClass {
  if (check.kind === 'nav-edge') {
    const to = String(check.params?.to ?? '');
    const depModule = ctx.screenToModule.get(normalizeScreenName(to));
    if (depModule && !ctx.unitModuleIds.has(depModule)) {
      const depUnit = ctx.moduleToUnit.get(depModule);
      const depStatus = depUnit ? ctx.ledger?.units[depUnit]?.status ?? null : null;
      if (!depStatus || !MIGRATED_STATES.has(depStatus)) return 'dependency-missing';
    }
  }
  return ctx.unitStatus && MIGRATED_STATES.has(ctx.unitStatus) ? 'unit-missing' : 'not-migrated';
}

// ---------------------------------------------------------------------------
// scoping + index helpers
// ---------------------------------------------------------------------------

function scopeExportsByPrefix(exports: ArkExport[], prefixes: string[]): ArkExport[] {
  return exports.filter((e) => {
    const rel = e.file.split('\\').join('/');
    return prefixes.some((p) => rel === p || rel.includes(p.endsWith('/') ? p : p + '/') || rel.startsWith(p));
  });
}

function scopeExportsByModuleName(exports: ArkExport[], moduleNames: string[]): ArkExport[] {
  const keys = moduleNames.map(normalizeKey).filter(Boolean);
  if (keys.length === 0) return [];
  return exports.filter((e) => keys.some((k) => normalizeKey(e.file).includes(k)));
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Screen node name → its owning ArchModule id (from app_contains). */
function screenNameToModuleId(graph: MigrationGraph): Map<string, string> {
  const moduleOfNode = new Map<string, string>();
  for (const e of graph.edges) {
    if (e.kind === 'app_contains') moduleOfNode.set(e.to, e.from);
  }
  const out = new Map<string, string>();
  for (const n of graph.nodes) {
    if (n.kind !== 'Screen' || n.platform !== 'android') continue;
    const moduleId = moduleOfNode.get(n.id);
    if (moduleId) out.set(normalizeScreenName(n.name), moduleId);
  }
  return out;
}

/** ArchModule id → the unit that gates its completion (its max-order slice). */
function moduleIdToUnitId(plan: MigrationPlan): Map<string, string> {
  const bestOrder = new Map<string, number>();
  const out = new Map<string, string>();
  for (const unit of plan.units) {
    for (const moduleId of unit.moduleIds) {
      const prev = bestOrder.get(moduleId);
      if (prev === undefined || unit.order > prev) {
        bestOrder.set(moduleId, unit.order);
        out.set(moduleId, unit.id);
      }
    }
  }
  return out;
}

function capEvidence(items: string[]): string[] {
  return [...new Set(items)].sort().slice(0, 20);
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
