/**
 * P · app-scaffold work order — the CROSS-UNIT global assembly facts no single
 * unit owns: the whole-app route table (every screen + its navigation, with the
 * unit that migrates it), the permission/deep-link declarations that live in one
 * shared `module.json5`, the EntryAbility wiring, and the full DataModel /
 * background-component inventory.
 *
 * It is deliberately NOT a `units[]` entry (that would perturb totalUnits/order);
 * it is a top-level `appScaffold` pointer, rendered as `units/00-app-scaffold.md`
 * so it sorts before unit 01. Its contract covers only app-level invariants
 * (deep links, permissions, entry abilities) — per-screen/edge acceptance stays
 * on the owning unit's contract.
 */

import {
  ContractCheck,
  UnitContract,
  UNIT_CONTRACT_SCHEMA_VERSION,
  checkId,
} from './contract';
import { MigrationPlan } from './index';

export const APP_SCAFFOLD_UNIT_ID = 'app-scaffold';
export const APP_SCAFFOLD_MODULE_ID = 'app';

interface RouteRow {
  screen: string;
  module: string;
  unitOrder: number;
  navigatesTo: string[];
}

/** Aggregate every unit's module briefs into the app-level view. */
function aggregate(plan: MigrationPlan): {
  routes: RouteRow[];
  dataModels: Array<{ name: string; module: string }>;
  background: Array<{ name: string; subtype: string; module: string }>;
  appEntries: string[];
  deeplinks: string[];
  permissions: string[];
} {
  const routes: RouteRow[] = [];
  // A module split into N slices carries its (un-sliceable) module-level facts on
  // EVERY slice's brief, so background components / data models would be pushed N
  // times (koler's CallService×9). Dedup by a stable key — the same discipline
  // appEntries/deeplinks/permissions already use via Set (T1-1).
  const dataModels = new Map<string, { name: string; module: string }>();
  const background = new Map<string, { name: string; subtype: string; module: string }>();
  const appEntries = new Set<string>();
  const deeplinks = new Set<string>();
  const permissions = new Set<string>();

  for (const unit of plan.units) {
    for (const m of unit.modules) {
      for (const s of m.screens) {
        // An xml-layout is a view resource, not a navigable route (a hosted one
        // is already folded into its host's `layouts`; a standalone one would
        // otherwise inflate the route table) — keep it out of the table (T1-6c).
        if (s.subtype === 'xml-layout') continue;
        routes.push({ screen: s.name, module: m.moduleName, unitOrder: unit.order, navigatesTo: s.navigatesTo });
      }
      for (const d of m.dataModels) {
        const key = `${d.name}\0${m.moduleName}`;
        if (!dataModels.has(key)) dataModels.set(key, { name: d.name, module: m.moduleName });
      }
      for (const b of m.backgroundComponents) {
        const key = `${b.name}\0${b.subtype}\0${m.moduleName}`;
        if (!background.has(key)) {
          background.set(key, { name: b.name, subtype: b.subtype, module: m.moduleName });
        }
      }
      for (const e of m.appEntries) appEntries.add(e);
      for (const dl of m.deeplinks) deeplinks.add(dl);
      for (const p of m.permissionCapabilities) permissions.add(p);
    }
  }
  routes.sort((a, b) => a.screen.localeCompare(b.screen));
  return {
    routes,
    dataModels: [...dataModels.values()].sort(
      (a, b) => a.name.localeCompare(b.name) || a.module.localeCompare(b.module)
    ),
    background: [...background.values()].sort(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        a.subtype.localeCompare(b.subtype) ||
        a.module.localeCompare(b.module)
    ),
    appEntries: [...appEntries].sort(),
    deeplinks: [...deeplinks].sort(),
    permissions: [...permissions].sort(),
  };
}

/** Render the app-scaffold work order markdown. */
export function renderAppScaffoldBrief(plan: MigrationPlan): string {
  const a = aggregate(plan);
  const lines: string[] = [];
  lines.push('# 迁移工单 00 · 应用装配 (app scaffold)');
  lines.push('');
  lines.push('> 跨单元的全局装配事实,由 `migrate plan` 确定性生成。这些不属于任何单个单元,');
  lines.push('> 而是整个应用共享(module.json5 / EntryAbility / 全局路由表)。先看它建立全局观,');
  lines.push('> 再按单元顺序逐个迁移;本工单的契约见 `plan/contracts/00-app-scaffold.json`。');
  lines.push('');

  renderBlindSpots(lines, plan);

  lines.push('## 全局路由表 [静态](所有屏幕 + 导航 + 迁移单元归属)');
  if (a.routes.length === 0) {
    lines.push('_(无屏幕)_');
  } else {
    for (const r of a.routes) {
      const nav = r.navigatesTo.length > 0 ? ` → ${r.navigatesTo.join(', ')}` : '';
      lines.push(`- ${r.screen}(${r.module} · 单元 ${r.unitOrder + 1})${nav}`);
    }
  }
  lines.push('');

  lines.push('## 启动入口与深链 [清单](目标 EntryAbility + module.json5 skills/uris)');
  lines.push(a.appEntries.length ? `- 启动入口:${a.appEntries.join(', ')}` : '- 启动入口:_(未识别)_');
  if (a.deeplinks.length) lines.push(`- 深链:${a.deeplinks.join(', ')}`);
  lines.push('');

  lines.push('## 权限能力总表 [清单](目标 module.json5 需声明对应 ohos.permission — 名称不同名,须逐条映射)');
  lines.push(a.permissions.length ? `- ${a.permissions.join(', ')}` : '- _(无权限能力)_');
  lines.push('');

  if (a.dataModels.length > 0) {
    lines.push('## 数据模型总表 [静态](目标 relationalStore / ArkTS interface)');
    for (const d of a.dataModels) lines.push(`- ${d.name}(${d.module})`);
    lines.push('');
  }

  if (a.background.length > 0) {
    lines.push('## 后台组件总表 [清单](目标 ExtensionAbility / 事件订阅)');
    for (const b of a.background) lines.push(`- ${b.name}(${b.subtype} · ${b.module})`);
    lines.push('');
  }

  lines.push('迁移完成后可用 `migrate verify <源> --target <目标> --unit scaffold` 核对 app 级契约。');
  lines.push('');
  return lines.join('\n');
}

/**
 * Known blind spots — the coverage warnings + third-party nav frameworks the
 * extraction could not fully recover. Without this section the warnings sit in
 * `migration-graph.json` where no consuming agent ever sees them, so silent
 * incompleteness reads as completeness (the exact failure P0-3 targets). Render
 * it FIRST so the agent treats the route table / screen list below as
 * known-incomplete, never as ground truth.
 */
function renderBlindSpots(lines: string[], plan: MigrationPlan): void {
  const warnings = plan.coverageWarnings ?? [];
  const frameworks = plan.navFrameworks ?? [];
  if (warnings.length === 0 && frameworks.length === 0) return;

  lines.push('## ⚠ 已知盲区(覆盖告警 —— 请勿把下方事实当作完整无遗漏)');
  if (frameworks.length > 0) {
    lines.push(
      `- 第三方导航/UI 框架:${frameworks.join('、')} —— 屏幕识别与页面跳转图不覆盖这些框架,` +
        `全局路由表很可能缺失大量页面与跳转,迁移时须以源码为准补全。`
    );
  }
  for (const w of warnings) {
    const ref = w.ref?.file ? ` (${w.ref.file}${w.ref.symbol ? `:${w.ref.symbol}` : ''})` : '';
    lines.push(`- ${w.message}${ref}`);
  }
  lines.push('');
}

/** Build the app-scaffold contract (app-level invariants only). */
export function buildAppScaffoldContract(plan: MigrationPlan): UnitContract {
  const a = aggregate(plan);
  const raw: Array<Omit<ContractCheck, 'id' | 'moduleId' | 'moduleName'>> = [];

  for (const uri of a.deeplinks) {
    raw.push({
      tier: 'L3', kind: 'deeplink', verify: 'auto', depth: 'contains-scan',
      subject: uri, expect: `深链 ${uri} 已在目标 module.json5 声明`, params: { deeplink: uri },
    });
  }
  for (const id of a.permissions) {
    raw.push({
      tier: 'L1', kind: 'capability', verify: 'agent',
      subject: id,
      expect: `权限能力 ${id} 已映射为对应 ohos.permission 并声明(名称不同名,人工核对)`,
      params: { capabilityId: id },
    });
  }
  for (const entry of a.appEntries) {
    raw.push({
      tier: 'L1', kind: 'background', verify: 'agent',
      subject: entry,
      expect: `启动入口 ${entry} 在目标侧有 EntryAbility 装配`,
      params: { name: entry, subtype: 'entry' },
    });
  }

  const checks: ContractCheck[] = raw
    .map((r) => ({
      ...r,
      id: checkId(r.kind, APP_SCAFFOLD_MODULE_ID, r.subject),
      moduleId: APP_SCAFFOLD_MODULE_ID,
      moduleName: 'app',
    }))
    .sort((x, y) => x.kind.localeCompare(y.kind) || x.subject.localeCompare(y.subject));

  return {
    schemaVersion: UNIT_CONTRACT_SCHEMA_VERSION,
    unitId: APP_SCAFFOLD_UNIT_ID,
    unitLabel: '应用装配 (app scaffold)',
    checks,
  };
}
