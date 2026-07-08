/**
 * P · unit acceptance contract — the machine-readable success criteria a
 * migration agent works against, one file per unit.
 *
 * The core idea: migration success = a set of LAYERED "migration invariants".
 * Only facts a platform translation must preserve VERBATIM belong here —
 * navigation topology, entity field sets, URL/SQL/key literals, enum value sets,
 * public surface names. Types, syntax, and framework structure are the target
 * compiler's job and are NEVER acceptance criteria (that would let a same-named
 * empty shell pass — the Goodhart risk the whole design guards against).
 *
 * Every check id is content-derived from (kind, moduleId, subject) — NOT the
 * unit envelope — so re-packing units (`--min/--max-unit-symbols`) MOVES a check
 * between contract files without changing its id. Verify findings therefore stay
 * diffable across re-packs and re-runs.
 */

import { createHash } from 'node:crypto';
import { VERIFIABLE_SPECS } from '../verify/parse-ets';
import { AssemblyInput, ModuleBrief, assembleModuleBrief } from './context';

export const UNIT_CONTRACT_SCHEMA_VERSION = 1;

export type CheckTier = 'L1' | 'L2' | 'L3' | 'L4' | 'info';
export type CheckKind =
  | 'interface' | 'screen' | 'model' | 'capability' | 'background' // L1
  | 'nav-edge' | 'di-binding'                                      // L2
  | 'constant' | 'route' | 'query' | 'enum-values' | 'deeplink'    // L3
  | 'state'                                                        // info
  | 'test';                                                        // L4
export type CheckVerify = 'auto' | 'agent' | 'info';
export type CheckDepth = 'symbol' | 'name-only' | 'contains-scan' | 'set-compare';

export interface ContractCheck {
  /** Content-derived id (see `checkId`) — stable across unit re-packs. */
  id: string;
  tier: CheckTier;
  kind: CheckKind;
  /** ArchModule node id — acceptance identity hangs on the module, not the unit. */
  moduleId: string;
  moduleName: string;
  /** Normalized subject key (see the per-kind rules in `checkId`). */
  subject: string;
  /** One-line human-readable expectation. */
  expect: string;
  verify: CheckVerify;
  /** Machine params for auto checks, shaped per kind. */
  params?: Record<string, unknown>;
  /** Honest nominal depth this check reaches. */
  depth?: CheckDepth;
}

export interface UnitContract {
  schemaVersion: number;
  unitId: string;
  unitLabel: string;
  /** Stable order: tier → kind → moduleName → subject. */
  checks: ContractCheck[];
}

/** The unit envelope fields the contract builder needs (UnitPlan satisfies it). */
export interface ContractUnitInput {
  id: string;
  order: number;
  label: string;
  moduleIds: string[];
  /** split only: the member files this sub-unit owns. */
  files?: string[];
}

/** `sha1("check\0"+kind+"\0"+moduleId+"\0"+subject)[:16]` — content identity. */
export function checkId(kind: CheckKind, moduleId: string, subject: string): string {
  return createHash('sha1')
    .update(`check\0${kind}\0${moduleId}\0${subject}`)
    .digest('hex')
    .slice(0, 16);
}

const VERIFIABLE_IDS = new Set(VERIFIABLE_SPECS.map((x) => x.spec.id));
const TIER_RANK: Record<CheckTier, number> = { L1: 0, L2: 1, L3: 2, L4: 3, info: 4 };

/**
 * Build one contract per unit. Checks are generated from WHOLE-module facts
 * (assembled fresh, unfiltered) and then assigned to units: a file-anchored
 * check goes to the slice whose files contain its anchor; a module-level check
 * (or an anchor no slice owns) goes to the module's highest-order slice — the
 * module-completion gate. Non-split modules have one slice, so all checks land
 * on their single unit.
 */
export function buildUnitContracts(
  units: ContractUnitInput[],
  input: AssemblyInput
): Map<string, UnitContract> {
  const contracts = new Map<string, UnitContract>();
  for (const u of units) {
    contracts.set(u.id, { schemaVersion: UNIT_CONTRACT_SCHEMA_VERSION, unitId: u.id, unitLabel: u.label, checks: [] });
  }

  // module id → the units (slices) covering it, sorted by order ascending.
  const slicesByModule = new Map<string, ContractUnitInput[]>();
  for (const u of units) {
    for (const moduleId of u.moduleIds) {
      const list = slicesByModule.get(moduleId) ?? [];
      list.push(u);
      slicesByModule.set(moduleId, list);
    }
  }
  for (const list of slicesByModule.values()) list.sort((a, b) => a.order - b.order);

  for (const [moduleId, slices] of [...slicesByModule.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const brief = assembleModuleBrief(moduleId, input);
    for (const raw of moduleChecks(brief)) {
      const unitId = assignUnit(raw, slices);
      const check: ContractCheck = {
        id: checkId(raw.kind, moduleId, raw.subject),
        tier: raw.tier,
        kind: raw.kind,
        moduleId,
        moduleName: brief.moduleName,
        subject: raw.subject,
        expect: raw.expect,
        verify: raw.verify,
        ...(raw.params ? { params: raw.params } : {}),
        ...(raw.depth ? { depth: raw.depth } : {}),
      };
      contracts.get(unitId)!.checks.push(check);
    }
  }

  // Dedup by check id (two public members can share a qualifiedName) so the
  // "check id set" is a true set, then sort — the pack-invariance guarantee.
  for (const contract of contracts.values()) {
    contract.checks = dedupById(contract.checks).sort(compareChecks);
  }
  return contracts;
}

function dedupById(checks: ContractCheck[]): ContractCheck[] {
  const seen = new Map<string, ContractCheck>();
  for (const c of checks) if (!seen.has(c.id)) seen.set(c.id, c);
  return [...seen.values()];
}

/** Assign a raw check to its owning unit id (split-aware). */
function assignUnit(raw: RawCheck, slices: ContractUnitInput[]): string {
  if (slices.length === 1) return slices[0]!.id;
  if (raw.file) {
    const owner = slices.find((s) => s.files?.includes(raw.file!));
    if (owner) return owner.id;
  }
  return slices[slices.length - 1]!.id; // module-completion gate (max-order slice)
}

function compareChecks(a: ContractCheck, b: ContractCheck): number {
  return (
    TIER_RANK[a.tier] - TIER_RANK[b.tier] ||
    a.kind.localeCompare(b.kind) ||
    a.moduleName.localeCompare(b.moduleName) ||
    a.subject.localeCompare(b.subject)
  );
}

// ---------------------------------------------------------------------------
// Per-module check generation — every check re-uses an existing fact source.
// ---------------------------------------------------------------------------

interface RawCheck {
  tier: CheckTier;
  kind: CheckKind;
  verify: CheckVerify;
  subject: string;
  expect: string;
  /** file anchor for split assignment (absent → module-level). */
  file?: string;
  params?: Record<string, unknown>;
  depth?: CheckDepth;
}

function moduleChecks(m: ModuleBrief): RawCheck[] {
  const out: RawCheck[] = [];

  // L1 · public interface (one check per member — split units anchor precisely).
  for (const member of m.publicInterface) {
    out.push({
      tier: 'L1', kind: 'interface', verify: 'auto', depth: 'name-only',
      subject: member.qualifiedName,
      expect: `公开成员 ${member.kind} ${member.name} 在目标侧有同名导出`,
      file: member.file,
      params: { name: member.name },
    });
  }

  // L1 · screens + L2 · navigation edges out of each screen.
  for (const s of m.screens) {
    out.push({
      tier: 'L1', kind: 'screen', verify: 'auto', depth: 'name-only',
      subject: s.name,
      expect: `屏幕 ${s.name} 在目标侧有对应页面`,
      file: s.file,
      params: { name: s.name },
    });
    for (const to of s.navigatesTo) {
      out.push({
        tier: 'L2', kind: 'nav-edge', verify: 'auto', depth: 'name-only',
        subject: `${s.name}->${to}`,
        expect: `导航关系 ${s.name} → ${to} 在目标侧保留`,
        file: s.file,
        params: { from: s.name, to },
      });
    }
  }

  // L1 · data models (field set is the invariant, not the class shape).
  for (const d of m.dataModels) {
    const fields = d.fields.map((f) => f.mappedName ?? f.name);
    out.push({
      tier: 'L1', kind: 'model', verify: 'auto', depth: 'set-compare',
      subject: d.name,
      expect: `数据模型 ${d.name} 的字段集在目标侧完整保留`,
      file: d.file,
      params: { name: d.name, fields },
    });
  }

  // L2 · DI bindings (both ends must exist on the target; not assembly).
  for (const b of m.di?.binds ?? []) {
    out.push({
      tier: 'L2', kind: 'di-binding', verify: 'auto', depth: 'name-only',
      subject: `${b.iface}<-${b.impl}`,
      expect: `DI 绑定 ${b.iface} ← ${b.impl}:接口与实现均在目标侧存在`,
      params: { iface: b.iface, impl: b.impl },
    });
  }

  // L1 · capabilities (auto only when a HarmonyOS marker exists; else info).
  const capIds = [...new Set([...m.capabilities.map((c) => c.id), ...m.permissionCapabilities])].sort();
  for (const id of capIds) {
    const verifiable = VERIFIABLE_IDS.has(id);
    out.push({
      tier: 'L1', kind: 'capability', verify: verifiable ? 'auto' : 'info',
      ...(verifiable ? { depth: 'contains-scan' as const } : {}),
      subject: id,
      expect: `能力 ${id} 在目标侧出现${verifiable ? '' : '(无自动标记,人工核对)'}`,
      params: { capabilityId: id },
    });
  }

  // L1 · background components (target Ability shapes vary — agent-verified).
  for (const c of m.backgroundComponents) {
    out.push({
      tier: 'L1', kind: 'background', verify: 'agent',
      subject: c.name,
      expect: `后台组件 ${c.name}(${c.subtype})在目标侧有对应 Ability/订阅`,
      params: { name: c.name, subtype: c.subtype },
    });
  }

  // L3 · migration-invariant literals.
  const c = m.constants;
  for (const lit of c?.literals ?? []) {
    out.push({
      tier: 'L3', kind: 'constant', verify: 'auto', depth: 'contains-scan',
      subject: `${lit.name}=${lit.value.slice(0, 120)}`,
      expect: `${lit.kind === 'url' ? 'URL' : '常量'} ${lit.name} 的字面量在目标侧原样存活`,
      file: lit.file,
      params: { value: lit.value },
    });
  }
  for (const r of c?.routes ?? []) {
    out.push({
      tier: 'L3', kind: 'route', verify: 'auto', depth: 'contains-scan',
      subject: `${r.method} ${r.path}`,
      expect: `路由 ${r.method} ${r.path} 在目标侧原样存活`,
      file: r.file,
      params: { method: r.method, path: r.path },
    });
  }
  for (const q of c?.queries ?? []) {
    out.push({
      tier: 'L3', kind: 'query', verify: 'auto', depth: 'contains-scan',
      subject: createHash('sha1').update(q.sql).digest('hex').slice(0, 12),
      expect: `SQL 语句在目标侧保留(空白归一后比对)`,
      file: q.file,
      params: { sql: q.sql },
    });
  }
  for (const e of c?.enums ?? []) {
    out.push({
      tier: 'L3', kind: 'enum-values', verify: 'auto', depth: 'set-compare',
      subject: e.name,
      expect: `枚举 ${e.name} 的取值集在目标侧完整保留`,
      file: e.file,
      params: { name: e.name, values: e.values },
    });
  }

  // L3 · deep links (module.json5 contains-scan).
  for (const uri of m.deeplinks) {
    out.push({
      tier: 'L3', kind: 'deeplink', verify: 'auto', depth: 'contains-scan',
      subject: uri,
      expect: `深链 ${uri} 已在目标 module.json5 声明`,
      params: { deeplink: uri },
    });
  }

  // info · exposed reactive state (naming is not preserved — advisory, never fails).
  for (const st of m.flows?.exposedStates ?? []) {
    out.push({
      tier: 'info', kind: 'state', verify: 'info',
      subject: st.name,
      expect: `暴露状态 ${st.name}:目标侧应有对应响应式状态(命名不保,仅提示)`,
      params: { name: st.name },
    });
  }

  // L4 · test-porting obligations (agent self-certifies; never auto-fails).
  for (const tc of m.testContract?.classes ?? []) {
    out.push({
      tier: 'L4', kind: 'test', verify: 'agent',
      subject: tc.name,
      expect: `移植 ${tc.name}(${tc.tests.length} 用例)的等价测试并自证通过`,
      file: tc.file,
      params: { name: tc.name, tests: tc.tests.length },
    });
  }

  return out;
}
