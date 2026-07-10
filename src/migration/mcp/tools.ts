/**
 * migrate MCP tools — the online query surface over the migration ANALYSIS
 * artifacts (.migration/migration-graph.json + plan/ + verify-report.json).
 *
 * Consumed by the external migration agent the work-order briefs point at.
 * Read-only over the file artifacts; nothing here recomputes analysis.
 *
 * Error discipline (learned upstream, see src/mcp/tools.ts): every EXPECTED
 * condition — artifacts not generated yet, unknown unit/module name — returns
 * a SUCCESS-SHAPED text response carrying the guidance, never `isError`. An
 * early `isError` teaches the agent to abandon the whole server.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AppNode, slug } from '../../appgraph/schema';
import { isLayoutHostingEdge } from '../../appgraph/detect/android-structure';
import { getLabelsPath, getLedgerPath, getMigrationDir, getPlanDir, getVerifyUnitsDir } from '../paths';
import { migrationGraphPath, readMigrationGraph } from '../serialize';
import { MigrationGraph } from '../types';
import { MigrationPlan, UnitPlan } from '../plan';
import { resolveUnit } from '../plan/resolve';
import { readLedger, Ledger, LedgerEntry } from '../ledger';
import {
  emptyLabelStore,
  LABEL_SUMMARY_MAX,
  LabelEntry,
  LabelStore,
  readLabelStore,
  validateLabel,
  writeLabelStore,
} from '../labels';
import { UnitContract } from '../plan/contract';
import { UnitVerifyReport } from '../verify/unit';

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface MigrateToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Shape of `.migration/verify-report.json` (written by `migrate verify`). */
interface VerifyReportDoc {
  method?: string;
  report?: {
    capabilityCoverage?: number;
    capabilities?: { matched?: string[]; missingInTarget?: string[]; extraInTarget?: string[] };
    gaps?: Array<{ id: string; severity?: string; detail?: string }>;
  };
  fidelity?: Array<{
    moduleName: string;
    sourceCount: number;
    matchedCount: number;
    missing: string[];
    scope?: string;
  }>;
  screenDiff?: { sourceCount?: number; targetCount?: number; missingInTarget?: string[] };
  entityDiff?: {
    models?: Array<{
      name: string;
      present?: boolean;
      missingFields?: string[];
      sourceFields?: number;
      fieldCheck?: string;
    }>;
    modelsMissing?: number;
    fieldsMissing?: number;
  };
}

const PROJECT_PATH_PROP = {
  projectPath: {
    type: 'string',
    description: '源工程根目录(默认用 serve --path 启动参数)',
  },
} as const;

export const MIGRATE_TOOLS: MigrateToolDef[] = [
  {
    name: 'migrate_order',
    description:
      '自底向上的迁移单元顺序(叶子优先)。返回每个单元的序号/标签/类型(模块|聚合|拆分)/符号量/工单文件,以及单元计划参数。迁移从第 1 个单元开始。',
    inputSchema: {
      type: 'object',
      properties: { ...PROJECT_PATH_PROP },
    },
  },
  {
    name: 'migrate_unit',
    description:
      '取一个迁移单元的完整工单:markdown 工单原文 + 前置/后继单元 + 该单元模块的验收缺口(若已 verify)。unit 可以是序号(如 "3")、单元 id、单元 label 或成员模块名。',
    inputSchema: {
      type: 'object',
      properties: {
        unit: {
          type: 'string',
          description: '单元序号 / 单元 id / 单元 label / 成员模块名(三选一即可)',
        },
        ...PROJECT_PATH_PROP,
      },
      required: ['unit'],
    },
  },
  {
    name: 'migrate_module_facts',
    description:
      '一个源模块的全部分析事实:屏幕+导航+宿主布局、实体字段 schema、DI 装配、响应式流、后台组件、深链/入口、能力→HarmonyOS 目标 API、公共接口(T3 验收基线)、声明与隐式依赖。迁移中需要依赖模块的上下文时用这个。',
    inputSchema: {
      type: 'object',
      properties: {
        module: { type: 'string', description: '模块名(如 ":core:data" 或 "core:data")' },
        ...PROJECT_PATH_PROP,
      },
      required: ['module'],
    },
  },
  {
    name: 'migrate_verify_gaps',
    description:
      '验收缺口。不带 unit:最近一次全量 migrate verify 的能力/T3 接口/V1 屏幕/V2 字段缺口(可用 module 过滤)。带 unit:该单元 verify --unit 报告,按 unit-missing/dependency-missing/not-migrated 分类。',
    inputSchema: {
      type: 'object',
      properties: {
        module: { type: 'string', description: '(可选)只看这个模块的接口缺口(全量模式)' },
        unit: { type: 'string', description: '(可选)看单个单元的 verify --unit 报告(序号/id/label/模块名/scaffold)' },
        ...PROJECT_PATH_PROP,
      },
    },
  },
  {
    name: 'migrate_ledger',
    description:
      '迁移台账:每个单元的迁移状态(pending/in-progress/migrated/verified/blocked)+目标模块/路径/导出改名。不带 unit 列全表;带 unit 出单条明细。台账由 “migrate ledger set” 写入,不要手改 JSON。',
    inputSchema: {
      type: 'object',
      properties: {
        unit: { type: 'string', description: '(可选)单元序号 / id / label / 模块名' },
        ...PROJECT_PATH_PROP,
      },
    },
  },
  {
    name: 'migrate_ready',
    description:
      '当前可开工的迁移单元,按并行波次分组:前置单元已全部 migrated/verified 且自身未开工的单元。多个转换 Agent 并行时用它取下一批可派发工单;完成单元用 “migrate ledger set … --status migrated” 登记后再查即得下一批。',
    inputSchema: { type: 'object', properties: { ...PROJECT_PATH_PROP } },
  },
  {
    name: 'app_screens',
    description:
      '应用屏幕清单:每个 Screen 的名称/类型(activity|fragment|compose|xml-layout…)及其 navigates_to 跳转目标。源工程的产品结构总览。',
    inputSchema: { type: 'object', properties: { ...PROJECT_PATH_PROP } },
  },
  {
    name: 'app_nav',
    description: '页面跳转图:全部 navigates_to 边(Screen → Screen),含派生自 Intent/Compose 导航的边。',
    inputSchema: { type: 'object', properties: { ...PROJECT_PATH_PROP } },
  },
  {
    name: 'app_features',
    description: '功能簇(Feature):确定性聚类出的功能模块及其成员。按“功能”而非工程模块看应用。',
    inputSchema: { type: 'object', properties: { ...PROJECT_PATH_PROP } },
  },
  {
    name: 'app_modules',
    description:
      '模块依赖图全景:每个 Gradle 模块的角色/层/必要性(产品|开发支撑)/符号量,及其声明依赖邻接表(已跑 migrate order 时按自底向上排序,否则按名称)。不需精确模块名,是 migrate_module_facts 的入口 —— 先用它看全局,再对具体模块查 facts。',
    inputSchema: { type: 'object', properties: { ...PROJECT_PATH_PROP } },
  },
  {
    name: 'migrate_label',
    description:
      '【写入】回填功能簇(Feature)或迁移单元的语义标注 —— 你可另起一个分析 Agent 读源码/工单后,把“语义名 + 功能与迁移要点说明”写回。这是唯一的写入通道,只做轻量校验(summary 必填、≤' +
      LABEL_SUMMARY_MAX +
      ' 字,允许多行;target 必须命中真实 Feature/单元),不合格只返回引导不写入。标注存于 sidecar(provenance=llm),不进确定性图谱/指纹,仅用于展示。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['feature', 'unit'], description: '标注对象类型' },
        key: {
          type: 'string',
          description: 'feature:Feature 的 sig 或 hub 名;unit:单元序号/id/label/成员模块名',
        },
        name: { type: 'string', description: '(可选)语义名,≤60 字,单行短标题' },
        summary: {
          type: 'string',
          description: '功能与迁移要点说明(必填,≤' + LABEL_SUMMARY_MAX + ' 字,可多行)',
        },
        ...PROJECT_PATH_PROP,
      },
      required: ['target', 'key', 'summary'],
    },
  },
];

const PIPELINE_HINT =
  '迁移图未生成。请在源工程依次运行:migrate index → modules → community → capabilities → semantics → order → plan(CLI:node dist/migration/cli.js <命令> <源工程根>),然后重试。';
const PLAN_HINT = '工单未生成。请在源工程运行 “migrate plan <源工程根>”,然后重试。';
const VERIFY_HINT =
  '验收报告未生成。请先运行 “migrate verify <源工程根> --target <目标 HarmonyOS 工程根>”,再查询缺口。';

/** How many list entries a fact section prints before eliding. */
const MAX_LIST = 50;

export class MigrateToolHandler {
  constructor(private readonly defaultRoot: string) {}

  listTools(): MigrateToolDef[] {
    return MIGRATE_TOOLS;
  }

  /** Thrown only for a tool NAME the server doesn't have (a protocol error). */
  static isKnownTool(name: string): boolean {
    return MIGRATE_TOOLS.some((t) => t.name === name);
  }

  execute(name: string, args: Record<string, unknown>): ToolResult {
    const root = typeof args.projectPath === 'string' ? resolve(args.projectPath) : this.defaultRoot;
    switch (name) {
      case 'migrate_order':
        return this.order(root);
      case 'migrate_unit':
        return this.unit(root, String(args.unit ?? ''));
      case 'migrate_module_facts':
        return this.moduleFacts(root, String(args.module ?? ''));
      case 'migrate_verify_gaps':
        return this.verifyGaps(
          root,
          typeof args.module === 'string' ? args.module : undefined,
          typeof args.unit === 'string' ? args.unit : undefined
        );
      case 'migrate_ledger':
        return this.ledger(root, typeof args.unit === 'string' ? args.unit : undefined);
      case 'migrate_ready':
        return this.ready(root);
      case 'app_screens':
        return this.appScreens(root);
      case 'app_nav':
        return this.appNav(root);
      case 'app_features':
        return this.appFeatures(root);
      case 'app_modules':
        return this.appModules(root);
      case 'migrate_label':
        return this.label(
          root,
          typeof args.target === 'string' ? args.target : '',
          typeof args.key === 'string' ? args.key : '',
          typeof args.name === 'string' ? args.name : undefined,
          typeof args.summary === 'string' ? args.summary : ''
        );
      default:
        throw new Error(`未知工具:${name}`);
    }
  }

  // --- data loading ----------------------------------------------------------

  private loadGraph(root: string): MigrationGraph | null {
    try {
      return readMigrationGraph(migrationGraphPath(root));
    } catch {
      return null;
    }
  }

  private loadPlan(root: string): MigrationPlan | null {
    return readJson<MigrationPlan>(join(getPlanDir(root), 'plan.json'));
  }

  private loadReport(root: string): VerifyReportDoc | null {
    return readJson<VerifyReportDoc>(join(getMigrationDir(root), 'verify-report.json'));
  }

  private planOrGuidance(root: string): { plan: MigrationPlan } | { guidance: ToolResult } {
    const plan = this.loadPlan(root);
    if (plan) return { plan };
    return { guidance: text(this.loadGraph(root) ? PLAN_HINT : PIPELINE_HINT) };
  }

  // --- migrate_order ----------------------------------------------------------

  private order(root: string): ToolResult {
    const loaded = this.planOrGuidance(root);
    if ('guidance' in loaded) return loaded.guidance;
    const { plan } = loaded;

    const lines: string[] = [];
    lines.push(`# 迁移单元顺序(自底向上,共 ${plan.totalUnits} 个)`);
    const p = plan.planning;
    if (p?.enabled) {
      lines.push(
        `单元计划:聚合 ${p.merged} · 拆分 ${p.split}(阈值 ${p.minUnitSymbols}–${p.maxUnitSymbols} 符号;` +
          `plan --no-unit-planning 可退回模块 1:1)`
      );
    }
    const devOnly = plan.units.filter((u) => u.necessity === 'dev-only');
    if (devOnly.length > 0) {
      lines.push(
        `其中 ${devOnly.length} 个是开发支撑单元(基准测试/测试工具/lint,标 [开发支撑]),不进产品包,已在同波次内沉到产品单元之后 —— 可最后迁移或按需跳过。`
      );
    }
    const blindSpots = (plan.coverageWarnings ?? []).length;
    const frameworks = plan.navFrameworks ?? [];
    if (blindSpots > 0 || frameworks.length > 0) {
      const fw = frameworks.length > 0 ? `第三方导航框架 ${frameworks.join('、')};` : '';
      lines.push(
        `⚠ 已知盲区:${fw}覆盖告警 ${blindSpots} 条 —— 屏幕/导航等事实可能不完整,详见应用装配工单 ${plan.appScaffold.briefFile}(migrate_unit {"unit":"scaffold"})。`
      );
    }
    const labels = readLabelStore(getLabelsPath(root));
    lines.push('');
    for (const u of plan.units) {
      pushWithAiLabel(
        lines,
        `${String(u.order + 1).padStart(3)}. ${u.label}${unitMark(u)} · 符号 ${u.symbolCount}${tokenNote(u)} → ${u.briefFile}`,
        labels?.units[u.id]
      );
    }
    lines.push('');
    lines.push('用 migrate_unit {"unit":"<序号或 label>"} 取某个单元的完整工单。');
    return text(lines.join('\n'));
  }

  // --- migrate_unit -----------------------------------------------------------

  private unit(root: string, query: string): ToolResult {
    const loaded = this.planOrGuidance(root);
    if ('guidance' in loaded) return loaded.guidance;
    const { plan } = loaded;

    // App-scaffold work order (cross-unit global assembly).
    if (['0', 'scaffold', 'app-scaffold'].includes(query.trim().toLowerCase())) {
      const brief = readText(join(getPlanDir(root), plan.appScaffold.briefFile));
      return text(brief ?? '(应用装配工单缺失 — 请重新运行 migrate plan)');
    }

    const unit = resolveUnit(plan, query);
    if (!unit) {
      const candidates = plan.units.slice(0, 20).map((u) => `${u.order + 1}. ${u.label}`);
      return text(
        `未找到单元 “${query}”。可用单元(前 20 个,完整清单用 migrate_order):\n${candidates.join('\n')}`
      );
    }

    const graph = this.loadGraph(root);
    const { prerequisites, dependents } = unitNeighbors(plan, unit, graph);

    const lines: string[] = [];
    lines.push(`# 单元 ${unit.order + 1}/${plan.totalUnits} · ${unit.label}`);
    lines.push(
      `类型 ${unitKindLabel(unit)} · 模块 ${unit.moduleIds.length} 个 · 符号 ${unit.symbolCount}` +
        (unit.files ? ` · 文件 ${unit.files.length} 个(拆分单元)` : '')
    );
    lines.push(
      prerequisites.length > 0
        ? `前置单元(应已完成):${prerequisites.join(' · ')}`
        : '前置单元:无(叶子单元,可直接开始)'
    );
    if (dependents.length > 0) lines.push(`后继单元(依赖本单元):${dependents.join(' · ')}`);

    const report = this.loadReport(root);
    if (report?.fidelity) {
      const names = new Set(unit.modules.map((m) => m.moduleName));
      const gaps = report.fidelity.filter((f) => names.has(f.moduleName) && f.missing.length > 0);
      if (gaps.length > 0) {
        lines.push('');
        lines.push('⚠ 最近一次 verify 的接口缺口(本单元模块):');
        for (const f of gaps) {
          lines.push(`- ${f.moduleName} 缺 ${f.missing.length}/${f.sourceCount}:${f.missing.slice(0, 10).join(', ')}`);
        }
      }
    }

    // Migration ledger status (where this unit's deps landed on the target).
    const ledger = readLedger(getLedgerPath(root));
    const entry = ledger?.units[unit.id];
    lines.push('');
    if (entry) {
      const tgt = entry.targetModule ? ` → ${entry.targetModule}` : '';
      lines.push(`台账状态:${entry.status}${tgt}${entry.targetPaths?.length ? ` [${entry.targetPaths.join(', ')}]` : ''}`);
    } else {
      lines.push('台账状态:pending(未登记) — 迁移后用 `migrate ledger set <源> <单元> --status migrated ...` 登记');
    }
    // Where this unit's DEPENDENCIES landed — independent of this unit's status.
    if (ledger) renderDependencyRenames(lines, plan, unit, ledger);

    // Acceptance contract summary (per-tier check counts + unit-report fails).
    renderContractSummary(lines, root, unit);

    lines.push('');
    lines.push(`--- 工单原文(${unit.briefFile})---`);
    lines.push('');
    const brief = readText(join(getPlanDir(root), unit.briefFile));
    lines.push(brief ?? '(工单文件缺失 — 请重新运行 migrate plan)');
    return text(lines.join('\n'));
  }

  // --- migrate_module_facts ----------------------------------------------------

  private moduleFacts(root: string, query: string): ToolResult {
    const graph = this.loadGraph(root);
    if (!graph) return text(PIPELINE_HINT);

    const modules = graph.nodes.filter(
      (n) => n.kind === 'ArchModule' && n.platform === 'android'
    );
    const module = findByName(modules, query);
    if (!module) {
      const candidates = suggest(modules, query);
      return text(`未找到模块 “${query}”。相近的模块:\n${candidates.join('\n')}`);
    }
    return text(renderModuleFacts(graph, module));
  }

  // --- migrate_verify_gaps -------------------------------------------------------

  private verifyGaps(root: string, moduleQuery?: string, unitQuery?: string): ToolResult {
    if (unitQuery !== undefined) return this.unitGaps(root, unitQuery);
    const report = this.loadReport(root);
    if (!report) return text(VERIFY_HINT);

    const lines: string[] = [];
    const r = report.report;
    lines.push(`# 验收缺口(解析方式 ${report.method ?? '未知'})`);
    if (r) {
      const coverage = typeof r.capabilityCoverage === 'number' ? Math.round(r.capabilityCoverage * 100) : null;
      lines.push(
        `能力覆盖 ${coverage !== null ? `${coverage}%` : '未知'}` +
          `(matched ${r.capabilities?.matched?.length ?? 0} · 缺口 ${r.capabilities?.missingInTarget?.length ?? 0})`
      );
      for (const g of r.gaps ?? []) {
        lines.push(`- ! [${g.severity ?? 'gap'}] ${g.id} — ${g.detail ?? ''}`);
      }
    }

    const fidelity = (report.fidelity ?? []).filter((f) => f.missing.length > 0);
    const scoped = moduleQuery
      ? fidelity.filter((f) => slug(f.moduleName).includes(slug(moduleQuery)))
      : fidelity;
    if (moduleQuery && scoped.length === 0) {
      lines.push('');
      lines.push(`模块 “${moduleQuery}” 无接口缺口(或未在最近一次 verify 中出现)。`);
    }
    if (scoped.length > 0) {
      lines.push('');
      lines.push(`## T3 · 公共接口缺失(${scoped.length} 个模块)`);
      for (const f of scoped) {
        lines.push(
          `- ${f.moduleName}(scope=${f.scope ?? 'global'})缺 ${f.missing.length}/${f.sourceCount}:` +
            f.missing.slice(0, 15).join(', ')
        );
      }
    }

    if (!moduleQuery) {
      const missingScreens = report.screenDiff?.missingInTarget ?? [];
      if (missingScreens.length > 0) {
        lines.push('');
        lines.push(`## V1 · 目标缺失屏幕(${missingScreens.length})`);
        lines.push(missingScreens.slice(0, MAX_LIST).join(', '));
      }
      const models = (report.entityDiff?.models ?? []).filter(
        (m) => m.present === false || (m.missingFields?.length ?? 0) > 0
      );
      if (models.length > 0) {
        lines.push('');
        lines.push(`## V2 · 实体 schema 缺口(${models.length} 个模型)`);
        for (const m of models.slice(0, MAX_LIST)) {
          lines.push(
            m.present === false
              ? `- ${m.name} — 目标无对应类`
              : `- ${m.name} — 缺字段 ${m.missingFields!.length}/${m.sourceFields ?? '?'}:${m.missingFields!.slice(0, 10).join(', ')}`
          );
        }
      }
    }

    if (lines.length <= 2) lines.push('无缺口 ✓');
    return text(lines.join('\n'));
  }

  // --- migrate_verify_gaps (unit mode) -------------------------------------------

  private unitGaps(root: string, unitQuery: string): ToolResult {
    const plan = this.loadPlan(root);
    const unit = plan ? resolveUnit(plan, unitQuery) : null;
    const isScaffold = ['0', 'scaffold', 'app-scaffold'].includes(unitQuery.trim().toLowerCase());
    const unitId = unit?.id ?? (isScaffold ? 'app-scaffold' : unitQuery);
    const report = readJson<UnitVerifyReport>(join(getVerifyUnitsDir(root), `${unitId}.json`));
    if (!report) {
      return text(
        `单元 “${unitQuery}” 尚无单元验收报告。先运行 “migrate verify <源工程> --target <目标工程> --unit ${unitQuery}” 生成后再查询。`
      );
    }
    const s = report.summary;
    const lines: string[] = [
      `# 单元验收缺口 · ${report.unitLabel}(作用域 ${report.scope} · 解析 ${report.method})`,
      `check ${s.total}:通过 ${s.pass} · 失败 ${s.fail} · 跳过 ${s.skipped} · 提示 ${s.info}`,
    ];
    const byClass = (cls: string) => report.checks.filter((c) => c.gapClass === cls);
    const um = byClass('unit-missing');
    if (um.length > 0) {
      lines.push('', `## 真实缺口 unit-missing(${um.length}) — 本单元已登记迁移却缺失`);
      for (const c of um.slice(0, 30)) {
        const ev = c.evidence?.length ? ` — 缺 ${c.evidence.slice(0, 5).join(', ')}` : '';
        lines.push(`- [${c.tier}] ${c.kind} ${c.subject}${ev}`);
      }
    }
    const dep = byClass('dependency-missing');
    if (dep.length > 0) {
      lines.push('', `## 依赖未就绪 dependency-missing(${dep.length}) — 先迁移其依赖单元`);
      for (const c of dep.slice(0, 20)) lines.push(`- ${c.kind} ${c.subject}`);
    }
    const nm = byClass('not-migrated');
    if (nm.length > 0) lines.push('', `(not-migrated ${nm.length} 条:本单元尚未登记迁移,非缺口)`);
    if (um.length === 0 && dep.length === 0) lines.push('', '无真实缺口 ✓');
    return text(lines.join('\n'));
  }

  // --- migrate_ledger ----------------------------------------------------------

  private ledger(root: string, unitQuery?: string): ToolResult {
    const led = readLedger(getLedgerPath(root));
    if (!led) {
      return text(
        '台账为空。迁移一个单元后用 “migrate ledger set <源工程> <单元> --status migrated [--target-module <m>] [--target-path <p>]” 登记,再来查询。'
      );
    }
    const plan = this.loadPlan(root);

    if (unitQuery !== undefined) {
      const unit = plan ? resolveUnit(plan, unitQuery) : null;
      const unitId = unit?.id ?? unitQuery;
      const e = led.units[unitId];
      if (!e) return text(`单元 “${unitQuery}”:pending(未登记)`);
      const lines = [`# 台账 · ${unit?.label ?? unitId}`, `状态:${e.status}`];
      if (e.targetModule) lines.push(`目标模块:${e.targetModule}`);
      if (e.targetPaths?.length) lines.push(`目标路径:${e.targetPaths.join(', ')}`);
      if (e.exportMap && Object.keys(e.exportMap).length > 0) {
        lines.push(`导出改名:${Object.entries(e.exportMap).map(([s, d]) => `${s}→${d}`).join(', ')}`);
      }
      if (e.notes) lines.push(`备注:${e.notes}`);
      lines.push(`更新:${e.updatedAt}`);
      return text(lines.join('\n'));
    }

    const lines = ['# 迁移台账'];
    if (plan) {
      for (const u of plan.units) {
        const e = led.units[u.id];
        lines.push(
          `${String(u.order + 1).padStart(3)}. ${u.label}: ${e ? e.status : 'pending(未登记)'}` +
            (e?.targetModule ? ` → ${e.targetModule}` : '')
        );
      }
      const planIds = new Set(plan.units.map((u) => u.id));
      const orphans = Object.keys(led.units).filter((id) => !planIds.has(id) && id !== 'app-scaffold');
      if (orphans.length > 0) lines.push(`⚠ orphan 条目(重 pack 后单元 id 变化,未删除):${orphans.join(', ')}`);
    } else {
      for (const [id, e] of Object.entries(led.units)) lines.push(`${id}: ${e.status}`);
    }
    return text(lines.join('\n'));
  }

  // --- migrate_ready -----------------------------------------------------------

  /**
   * Scheduler-facing readiness view: units whose prerequisites are all
   * migrated/verified and that haven't started, grouped by parallel wave.
   * Everything derives from plan.json (schema ≥ 4) + ledger.json — no graph
   * re-derivation, so an external orchestrator sees exactly what the plan says.
   */
  private ready(root: string): ToolResult {
    const loaded = this.planOrGuidance(root);
    if ('guidance' in loaded) return loaded.guidance;
    const { plan } = loaded;

    if (plan.units.some((u) => !Array.isArray(u.dependsOnUnitIds))) {
      return text(
        'plan.json 是旧版(schema<4),没有持久化的单元依赖/波次字段。请重新运行 “migrate plan <源工程根>” 后再查询可开工单元。'
      );
    }

    const led = readLedger(getLedgerPath(root));
    const statusOf = (id: string): string => led?.units[id]?.status ?? 'pending';
    const done = (id: string): boolean => {
      const s = statusOf(id);
      return s === 'migrated' || s === 'verified';
    };

    const ready: UnitPlan[] = [];
    const inProgress: UnitPlan[] = [];
    const blocked: UnitPlan[] = [];
    let doneCount = 0;
    for (const u of plan.units) {
      const s = statusOf(u.id);
      if (s === 'migrated' || s === 'verified') doneCount++;
      else if (s === 'in-progress') inProgress.push(u);
      else if (s === 'blocked') blocked.push(u);
      else if (u.dependsOnUnitIds.every(done)) ready.push(u);
    }

    const refs = (us: UnitPlan[]): string => us.map((u) => `${u.order + 1}. ${u.label}`).join(' · ');
    const lines: string[] = [`# 可开工单元 · 进度 ${doneCount}/${plan.totalUnits}`];
    if (ready.length === 0) {
      lines.push(
        doneCount >= plan.totalUnits
          ? '全部单元已迁移完成 ✓(可运行 migrate verify 做全量核对)'
          : inProgress.length > 0
            ? '当前无新的可开工单元 — 等待进行中的单元完成登记(migrate ledger set <单元> --status migrated)后再查询。'
            : '无可开工单元。用 migrate_ledger 检查台账 — 可能有 blocked 单元卡住了后继。'
      );
    } else {
      const byWave = new Map<number, UnitPlan[]>();
      for (const u of ready) {
        const w = u.wave ?? 0;
        (byWave.get(w) ?? byWave.set(w, []).get(w)!).push(u);
      }
      for (const wave of [...byWave.keys()].sort((a, b) => a - b)) {
        const us = byWave.get(wave)!;
        lines.push('', `## 波次 ${wave}(${us.length} 个,相互无依赖,可并行迁移)`);
        for (const u of us) {
          lines.push(
            `${String(u.order + 1).padStart(3)}. ${u.label}${unitMark(u)} · 符号 ${u.symbolCount} → ${u.briefFile}`
          );
        }
      }
      lines.push('', '领取单元先登记 in-progress,完成后登记 migrated,再查本工具取下一批:');
      lines.push('migrate ledger set <源工程> "<单元>" --status in-progress|migrated');
    }
    if (inProgress.length > 0) lines.push('', `进行中(${inProgress.length}):${refs(inProgress)}`);
    if (blocked.length > 0) lines.push('', `⚠ blocked(${blocked.length}):${refs(blocked)}`);
    return text(lines.join('\n'));
  }

  // --- app-semantic views (read the migration graph's app layer) -------------

  private appScreens(root: string): ToolResult {
    const graph = this.loadGraph(root);
    if (!graph) return text(PIPELINE_HINT);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const navFrom = new Map<string, string[]>();
    for (const e of graph.edges) {
      if (e.kind !== 'navigates_to') continue;
      const to = byId.get(e.to);
      if (to) (navFrom.get(e.from) ?? navFrom.set(e.from, []).get(e.from)!).push(to.name);
    }
    const screens = graph.nodes.filter((n) => n.kind === 'Screen').sort(byName);
    const lines = [`Screen ${screens.length} 个:`];
    for (const s of screens.slice(0, MAX_LIST)) {
      const targets = (navFrom.get(s.id) ?? []).sort();
      const sub = s.subtype ? ` [${s.subtype}]` : '';
      const nav = targets.length ? ` → ${targets.join(', ')}` : '';
      lines.push(`  · ${s.name}${sub}${nav}`);
    }
    if (screens.length > MAX_LIST) lines.push(`  … 及另外 ${screens.length - MAX_LIST} 个`);
    return text(lines.join('\n'));
  }

  private appNav(root: string): ToolResult {
    const graph = this.loadGraph(root);
    if (!graph) return text(PIPELINE_HINT);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const edges = graph.edges
      .filter((e) => e.kind === 'navigates_to')
      .map((e) => ({ from: byId.get(e.from)?.name ?? e.from, to: byId.get(e.to)?.name ?? e.to }))
      .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
    const lines = [`navigates_to ${edges.length} 条:`];
    for (const e of edges.slice(0, MAX_LIST)) lines.push(`  ${e.from} → ${e.to}`);
    if (edges.length > MAX_LIST) lines.push(`  … 及另外 ${edges.length - MAX_LIST} 条`);
    return text(lines.join('\n'));
  }

  private appFeatures(root: string): ToolResult {
    const graph = this.loadGraph(root);
    if (!graph) return text(PIPELINE_HINT);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const members = new Map<string, string[]>();
    for (const e of graph.edges) {
      if (e.kind !== 'app_contains') continue;
      const from = byId.get(e.from);
      const to = byId.get(e.to);
      if (from?.kind === 'Feature' && to) {
        (members.get(e.from) ?? members.set(e.from, []).get(e.from)!).push(to.name);
      }
    }
    const labels = readLabelStore(getLabelsPath(root));
    const features = graph.nodes.filter((n) => n.kind === 'Feature').sort(byName);
    const lines = [`Feature ${features.length} 个:`];
    let labelled = 0;
    for (const f of features.slice(0, MAX_LIST)) {
      const ms = (members.get(f.id) ?? []).sort();
      // A weak (low-trust) cross-module grab-bag is flagged so the agent knows
      // not to treat it as one coherent feature.
      const weak = f.attrs?.weak === true ? ' ⚠低置信(跨模块杂合,勿当作单一功能)' : '';
      const label = labels?.features[String(f.attrs?.sig ?? '')];
      if (label) labelled++;
      pushWithAiLabel(lines, `  · ${f.name}${weak}${ms.length ? `: ${ms.join(', ')}` : ''}`, label);
    }
    if (labels && labelled < Math.min(features.length, MAX_LIST)) {
      lines.push('提示:未标注的功能簇可另起分析 Agent 用 migrate_label 回填语义名/描述。');
    }
    if (features.length > MAX_LIST) lines.push(`  … 及另外 ${features.length - MAX_LIST} 个`);
    return text(lines.join('\n'));
  }

  /**
   * Module dependency graph overview — role/layer/necessity/symbolCount + the
   * declared depends_on adjacency, bottom-up. The entry point migrate_module_facts
   * was missing: an agent had to already know a module name to query it.
   */
  private appModules(root: string): ToolResult {
    const graph = this.loadGraph(root);
    if (!graph) return text(PIPELINE_HINT);
    // Bottom-up order: place each module by its migration unit's order (computed
    // by `migrate order`), so dependencies come first — matching the header's
    // claim. Fall back to name order (and say so) when no order has been run.
    const orderByModuleId = new Map<string, number>();
    for (const u of graph.order?.units ?? []) {
      for (const mid of u.moduleIds) orderByModuleId.set(mid, u.order);
    }
    const modules = graph.nodes
      .filter((n) => n.kind === 'ArchModule' && n.platform === 'android')
      .sort((a, b) => {
        const oa = orderByModuleId.get(a.id);
        const ob = orderByModuleId.get(b.id);
        if (oa !== undefined && ob !== undefined && oa !== ob) return oa - ob;
        if (oa === undefined && ob !== undefined) return 1; // un-ordered sink to end
        if (oa !== undefined && ob === undefined) return -1;
        return a.name.localeCompare(b.name);
      });
    if (modules.length === 0) {
      return text('未发现 Gradle 模块(工程可能是单模块或未跑 migrate modules)。');
    }
    // Only claim "bottom-up" when EVERY module is placed by the order — a stale
    // or partial order (new modules not yet synced) would sink the uncovered
    // ones to the end, which is not a faithful bottom-up listing.
    const ordered = modules.every((m) => orderByModuleId.has(m.id));

    // Declared (manifest) depends_on adjacency; test-scoped deps listed apart.
    const nameById = new Map(modules.map((m) => [m.id, m.name]));
    const deps = new Map<string, string[]>();
    const testDeps = new Map<string, string[]>();
    for (const e of graph.edges) {
      if (e.kind !== 'depends_on' || e.provenance !== 'manifest') continue;
      const to = nameById.get(e.to);
      if (!to || !nameById.has(e.from)) continue;
      const bucket = e.attrs?.scope === 'test' ? testDeps : deps;
      bucket.set(e.from, [...(bucket.get(e.from) ?? []), to]);
    }

    const devOnly = modules.filter((m) => m.attrs?.necessity === 'dev-only').length;
    const lines = [`# 模块依赖图(${modules.length} 个模块${devOnly ? `,其中 ${devOnly} 个开发支撑` : ''})`];
    lines.push(
      ordered
        ? '每行:模块 · 角色/层/必要性 · 符号量 → 声明依赖(按迁移顺序自底向上,依赖排在更早迁移)'
        : '每行:模块 · 角色/层/必要性 · 符号量 → 声明依赖(按名称排序;跑 migrate order 后可按自底向上排序)'
    );
    lines.push('');
    for (const m of modules) {
      const a = m.attrs ?? {};
      const tags = [
        m.subtype ? `角色 ${m.subtype}` : '',
        typeof a.layer === 'string' ? `层 ${a.layer}` : '',
        a.necessity === 'dev-only' ? '开发支撑' : '产品',
        typeof a.symbolCount === 'number' ? `符号 ${a.symbolCount}` : '',
      ].filter(Boolean).join(' · ');
      const d = (deps.get(m.id) ?? []).sort();
      const td = (testDeps.get(m.id) ?? []).sort();
      lines.push(
        `· ${m.name} [${tags}]` +
          (d.length ? ` → ${d.join(', ')}` : ' → (叶子)') +
          (td.length ? `;测试期依赖 ${td.join(', ')}` : '')
      );
    }
    lines.push('');
    lines.push('看某模块完整事实用 migrate_module_facts {"module":"<模块名>"}。');
    return text(lines.join('\n'));
  }

  /**
   * Controlled LLM label write-back (P1-3b). Resolves the target to a REAL
   * Feature sig / unit id, runs the strict quality gate, and persists to the
   * labels sidecar. Every failure (unknown target, bad input) returns
   * success-shaped guidance — a rejected write is "fix your input", not a reason
   * to abandon the server.
   */
  private label(root: string, target: string, key: string, name: string | undefined, summary: string): ToolResult {
    if (target !== 'feature' && target !== 'unit') {
      return text('target 必须是 "feature" 或 "unit"。feature 标注功能簇,unit 标注迁移单元。');
    }
    const graph = this.loadGraph(root);
    if (!graph) return text(PIPELINE_HINT);

    // Resolve the key to a real target id/sig BEFORE validating content.
    let resolvedKey: string;
    let resolvedLabel: string;
    if (target === 'feature') {
      const feature = resolveFeature(graph, key);
      if (!feature) {
        const names = graph.nodes.filter((n) => n.kind === 'Feature').slice(0, 15).map((f) => `${f.name}(${f.attrs?.sig ?? '?'})`);
        return text(`未找到功能簇 “${key}”。用 app_features 查看可标注的 Feature(名/sig):\n${names.join('\n')}`);
      }
      resolvedKey = String(feature.attrs?.sig ?? feature.matchKey);
      resolvedLabel = feature.name;
    } else {
      const plan = this.loadPlan(root);
      if (!plan) return text(PLAN_HINT);
      const unit = resolveUnit(plan, key);
      if (!unit) return text(`未找到单元 “${key}”。用 migrate_order 查看单元序号/label。`);
      resolvedKey = unit.id;
      resolvedLabel = `${unit.order + 1}. ${unit.label}`;
    }

    const result = validateLabel({ name, summary });
    if ('error' in result) return text(`标注未写入:${result.error}`);

    const path = getLabelsPath(root);
    const store: LabelStore = readLabelStore(path) ?? emptyLabelStore();
    const bucket = target === 'feature' ? store.features : store.units;
    bucket[resolvedKey] = result.entry;
    writeLabelStore(path, store);

    const shown = result.entry.name ? `${result.entry.name} — ${result.entry.summary}` : result.entry.summary;
    return text(`已写回${target === 'feature' ? '功能簇' : '单元'} 标注 · ${resolvedLabel}\n  ${shown}\n(provenance=llm,存于 labels.json,不影响图谱确定性)`);
  }
}

function byName(a: AppNode, b: AppNode): number {
  return a.name.localeCompare(b.name);
}

/**
 * Append an optional `migrate_label` AI annotation after a fact line. A
 * single-line summary stays inline (`〔AI:name — summary〕`); a multi-line one
 * renders as an indented block below so the fact line itself stays scannable.
 */
function pushWithAiLabel(lines: string[], header: string, label: LabelEntry | undefined): void {
  if (!label) {
    lines.push(header);
    return;
  }
  const summaryLines = label.summary.split('\n');
  if (summaryLines.length === 1) {
    lines.push(`${header} 〔AI:${label.name ? `${label.name} — ` : ''}${summaryLines[0]}〕`);
    return;
  }
  lines.push(`${header} 〔AI:${label.name ?? '…'}〕`);
  for (const l of summaryLines) lines.push(`      ${l}`);
}

// =============================================================================
// helpers
// =============================================================================

/** "your deps landed here / renamed to X" — the top of migrate_unit. */
function renderDependencyRenames(
  lines: string[],
  plan: MigrationPlan,
  unit: UnitPlan,
  ledger: Ledger
): void {
  const depNames = new Set(unit.modules.flatMap((m) => m.dependencies.map((d) => d.moduleName)));
  if (depNames.size === 0) return;
  const unitByModuleName = new Map<string, string>();
  for (const u of plan.units) for (const m of u.modules) unitByModuleName.set(m.moduleName, u.id);

  const targets: string[] = [];
  const renames: string[] = [];
  for (const name of [...depNames].sort()) {
    const uid = unitByModuleName.get(name);
    const e: LedgerEntry | undefined = uid ? ledger.units[uid] : undefined;
    if (!e) continue;
    if (e.targetModule) targets.push(`${name} → ${e.targetModule}`);
    for (const [s, d] of Object.entries(e.exportMap ?? {})) renames.push(`${s}→${d}`);
  }
  if (targets.length > 0) lines.push(`依赖去向:${targets.join(' · ')}`);
  if (renames.length > 0) lines.push(`依赖导出改名(前 10):${renames.slice(0, 10).join(', ')}`);
}

/** Per-tier check counts + the latest verify --unit fails (if any). */
function renderContractSummary(lines: string[], root: string, unit: UnitPlan): void {
  if (!unit.contractFile) return; // pre-schema-3 plan.json without contracts
  const contract = readJson<UnitContract>(join(getPlanDir(root), unit.contractFile));
  if (!contract) return;
  const byTier: Record<string, number> = {};
  for (const c of contract.checks) byTier[c.tier] = (byTier[c.tier] ?? 0) + 1;
  const tiers = Object.entries(byTier).sort(([a], [b]) => a.localeCompare(b)).map(([t, n]) => `${t}:${n}`);
  lines.push(`验收契约:${contract.checks.length} check(${tiers.join(' ')})`);

  const report = readJson<UnitVerifyReport>(join(getVerifyUnitsDir(root), `${unit.id}.json`));
  if (report) {
    const s = report.summary;
    lines.push(`  最近 verify --unit:失败 ${s.fail} · 跳过 ${s.skipped} · 通过 ${s.pass}`);
    for (const c of report.checks.filter((c) => c.status === 'fail').slice(0, 5)) {
      lines.push(`  ! ${c.kind} ${c.subject}`);
    }
  }
}

function text(t: string): ToolResult {
  return { content: [{ type: 'text', text: t }] };
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** ` · ~12.3k tok` migration-size estimate, when the plan carries it (P1-3). */
function tokenNote(u: UnitPlan): string {
  if (typeof u.estimatedTokens !== 'number') return '';
  const t = u.estimatedTokens;
  return ` · ~${t >= 1000 ? `${(t / 1000).toFixed(1)}k` : t} tok`;
}

function unitMark(u: UnitPlan): string {
  const dev = u.necessity === 'dev-only' ? ' [开发支撑]' : '';
  if (u.cyclic) return ` [SCC]${dev}`;
  if (u.kind === 'merged') return ` [聚合]${dev}`;
  if (u.kind === 'split') return ` [拆分]${dev}`;
  return dev;
}

function unitKindLabel(u: UnitPlan): string {
  if (u.cyclic) return '依赖环(SCC,须一并迁移)';
  if (u.kind === 'merged') return '聚合单元(多个小模块装箱)';
  if (u.kind === 'split') return `拆分单元(模块功能子集${u.featureSig === 'rest' ? ':剩余部分' : ''})`;
  return '模块单元';
}

/** Prerequisite/dependent unit labels, from declared deps + split siblings. */
function unitNeighbors(
  plan: MigrationPlan,
  unit: UnitPlan,
  graph: MigrationGraph | null
): { prerequisites: string[]; dependents: string[] } {
  // Plan schema ≥ 4 persists the unit-level projection — read it verbatim so
  // the answer always matches plan.json (the on-the-fly derivation below stays
  // as the fallback for pre-v4 plan documents).
  if (plan.units.every((u) => Array.isArray(u.dependsOnUnitIds))) {
    const byId = new Map(plan.units.map((u) => [u.id, u]));
    const ref = (u: UnitPlan): string => `${u.order + 1}. ${u.label}`;
    return {
      prerequisites: unit.dependsOnUnitIds
        .map((id) => byId.get(id))
        .filter((u): u is UnitPlan => u !== undefined)
        .sort((a, b) => a.order - b.order)
        .map(ref),
      dependents: plan.units
        .filter((u) => u.id !== unit.id && u.dependsOnUnitIds.includes(unit.id))
        .sort((a, b) => a.order - b.order)
        .map(ref),
    };
  }

  const deps = new Set<string>(); // module id → depends on module id
  if (graph) {
    for (const e of graph.edges) {
      if (e.kind === 'depends_on' && e.provenance === 'manifest' && e.attrs?.scope !== 'test')
        deps.add(`${e.from}\0${e.to}`);
    }
  }
  const dependsOn = (a: UnitPlan, b: UnitPlan): boolean =>
    a.moduleIds.some((x) => b.moduleIds.some((y) => deps.has(`${x}\0${y}`))) ||
    // Split siblings of the same module depend on the earlier slices.
    (a.moduleIds.length === 1 && a.moduleIds[0] === b.moduleIds[0] && a.id !== b.id);

  const prerequisites: string[] = [];
  const dependents: string[] = [];
  for (const other of plan.units) {
    if (other.id === unit.id) continue;
    if (other.order < unit.order && dependsOn(unit, other)) {
      prerequisites.push(`${other.order + 1}. ${other.label}`);
    } else if (other.order > unit.order && dependsOn(other, unit)) {
      dependents.push(`${other.order + 1}. ${other.label}`);
    }
  }
  return { prerequisites, dependents };
}

/** Resolve a Feature by its sig (exact) or hub name (exact, then unique substring). */
function resolveFeature(graph: MigrationGraph, query: string): AppNode | null {
  const features = graph.nodes.filter((n) => n.kind === 'Feature');
  const q = query.trim();
  const bySig = features.find((f) => String(f.attrs?.sig ?? '') === q);
  if (bySig) return bySig;
  const byName = features.filter((f) => f.name === q);
  if (byName.length === 1) return byName[0]!;
  const near = features.filter((f) => q.length >= 3 && f.name.includes(q));
  return near.length === 1 ? near[0]! : null;
}

function findByName(modules: AppNode[], query: string): AppNode | null {
  const q = query.trim();
  const qs = slug(q);
  return (
    modules.find((m) => m.name === q) ??
    modules.find((m) => slug(m.name) === qs) ??
    modules.find((m) => slug(m.name).includes(qs) && qs.length >= 3) ??
    null
  );
}

function suggest(modules: AppNode[], query: string): string[] {
  const qs = slug(query);
  const near = modules.filter((m) => qs.length >= 2 && slug(m.name).includes(qs)).map((m) => m.name);
  const pool = near.length > 0 ? near : modules.map((m) => m.name);
  return pool.sort().slice(0, 20).map((n) => `- ${n}`);
}

/** Render one module's full analysis facts off the enriched graph. */
function renderModuleFacts(graph: MigrationGraph, module: AppNode): string {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const lines: string[] = [];
  const attrs = module.attrs ?? {};

  lines.push(`# 模块 ${module.name}`);
  const meta = [
    module.subtype ? `角色 ${module.subtype}` : '',
    typeof attrs.layer === 'string' ? `层 ${attrs.layer}` : '',
    typeof attrs.symbolCount === 'number' ? `符号 ${attrs.symbolCount}` : '',
    typeof attrs.dir === 'string' ? `目录 ${attrs.dir}` : '',
  ].filter(Boolean);
  if (meta.length) lines.push(meta.join(' · '));

  if (attrs.roleCounts && typeof attrs.roleCounts === 'object') {
    const counts = Object.entries(attrs.roleCounts as Record<string, number>)
      .map(([k, v]) => `${k}×${v}`)
      .join(' · ');
    lines.push(`组件角色分布:${counts}`);
  }

  // Owned nodes via app_contains; layout hosting + deep links via their edges.
  const owned: AppNode[] = [];
  const layoutsByScreen = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.kind === 'app_contains' && e.from === module.id) {
      const n = nodeById.get(e.to);
      if (n) owned.push(n);
    }
    if (isLayoutHostingEdge(e)) {
      const layout = nodeById.get(e.to);
      if (layout) {
        const list = layoutsByScreen.get(e.from) ?? [];
        list.push(layout.name);
        layoutsByScreen.set(e.from, list);
      }
    }
  }
  const navByScreen = new Map<string, string[]>();
  const deeplinks: string[] = [];
  const ownedIds = new Set(owned.map((n) => n.id));
  for (const e of graph.edges) {
    if (e.kind === 'navigates_to' && ownedIds.has(e.from)) {
      const to = nodeById.get(e.to);
      if (to) {
        const list = navByScreen.get(e.from) ?? [];
        list.push(to.name);
        navByScreen.set(e.from, list);
      }
    }
    if (e.kind === 'exposes' && ownedIds.has(e.from)) {
      const res = nodeById.get(e.to);
      if (res) deeplinks.push(res.name);
    }
  }

  const hostedLayouts = new Set([...layoutsByScreen.values()].flat());
  const screens = owned
    .filter((n) => n.kind === 'Screen' && !hostedLayouts.has(n.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  section(lines, `## 屏幕(${screens.length})`, screens.slice(0, MAX_LIST).map((s) => {
    const nav = (navByScreen.get(s.id) ?? []).sort();
    const layouts = (layoutsByScreen.get(s.id) ?? []).sort();
    return (
      `- ${s.name}(${s.subtype ?? 'screen'})${s.platformRef?.file ? ` — ${s.platformRef.file}` : ''}` +
      (nav.length ? `;导航至 ${nav.join(', ')}` : '') +
      (layouts.length ? `;关联布局 ${layouts.join(', ')}` : '')
    );
  }), screens.length);

  const models = owned.filter((n) => n.kind === 'DataModel').sort((a, b) => a.name.localeCompare(b.name));
  section(lines, `## 数据模型(${models.length})`, models.slice(0, MAX_LIST).map((m) => {
    const fields = Array.isArray(m.attrs?.fields) ? (m.attrs.fields as Array<{ name: string; type: string }>) : [];
    return `- ${m.name}(${m.subtype ?? 'entity'}):${fields.map((f) => `${f.name}:${f.type}`).join(', ') || '(无字段信息)'}`;
  }), models.length);

  const components = owned
    .filter((n) => n.kind === 'BackgroundComponent')
    .sort((a, b) => a.name.localeCompare(b.name));
  section(lines, `## 后台组件(${components.length})`, components.map((c) => {
    return `- ${c.name}(${c.subtype})${c.attrs?.harmonyModule ? ` → ${c.attrs.harmonyModule}` : ''}`;
  }), components.length);

  const entries = owned.filter((n) => n.kind === 'AppEntry').map((n) => n.name).sort();
  if (entries.length > 0 || deeplinks.length > 0) {
    lines.push('');
    lines.push('## 对外入口与深链');
    if (entries.length) lines.push(`- 启动入口:${entries.join(', ')}`);
    if (deeplinks.length) lines.push(`- 深链:${[...new Set(deeplinks)].sort().join(', ')}`);
  }

  const caps: string[] = [];
  for (const e of graph.edges) {
    if (e.kind !== 'uses_capability' || e.from !== module.id) continue;
    const cap = nodeById.get(e.to);
    if (cap) caps.push(`- ${cap.name}${cap.attrs?.harmonyModule ? ` → ${cap.attrs.harmonyModule}` : '(无目标映射)'}`);
  }
  section(lines, `## 能力 → HarmonyOS 目标(${caps.length})`, [...new Set(caps)].sort(), caps.length);

  if (attrs.di && typeof attrs.di === 'object') {
    lines.push('');
    lines.push('## DI 装配(源侧 Hilt,目标需手动装配)');
    lines.push(compactJson(attrs.di));
  }
  if (attrs.flows && typeof attrs.flows === 'object') {
    lines.push('');
    lines.push('## 响应式数据流');
    lines.push(compactJson(attrs.flows));
  }

  const publicInterface = Array.isArray(attrs.publicInterface)
    ? (attrs.publicInterface as string[])
    : [];
  section(
    lines,
    `## 公共接口(T3 验收基线,${publicInterface.length} 个成员)`,
    publicInterface.slice(0, MAX_LIST).map((n) => `- ${n}`),
    publicInterface.length
  );
  if (publicInterface.length === 0) {
    lines.push('(未持久化 — 运行 migrate plan 后重新查询)');
  }

  const declared: string[] = [];
  const testScoped: string[] = [];
  const implied: string[] = [];
  for (const e of graph.edges) {
    if (e.kind !== 'depends_on' || e.from !== module.id) continue;
    const to = nodeById.get(e.to);
    if (!to || to.kind !== 'ArchModule') continue;
    if (e.provenance === 'manifest') {
      (e.attrs?.scope === 'test' ? testScoped : declared).push(`- ${to.name}`);
    } else {
      const suspect = e.attrs?.suspect === 'reverse-of-declared' ? ' ⚠反向可疑(与声明依赖方向相反,多为解析噪声)' : '';
      implied.push(`- ${to.name}(权重 ${e.attrs?.weight ?? '?'})${suspect}`);
    }
  }
  section(lines, `## 声明依赖(${declared.length})`, declared.sort(), declared.length);
  section(
    lines,
    `## 测试期依赖(${testScoped.length},不阻塞迁移)`,
    testScoped.sort(),
    testScoped.length
  );
  section(lines, `## 隐式耦合 [启发](${implied.length})`, implied.sort(), implied.length);

  return lines.join('\n');
}

function section(lines: string[], header: string, items: string[], total: number): void {
  if (total === 0) return;
  lines.push('');
  lines.push(header);
  lines.push(...items);
  if (total > items.length) lines.push(`- …共 ${total} 条(其余省略)`);
}

function compactJson(value: unknown): string {
  const s = JSON.stringify(value, null, 1);
  return s.length > 4000 ? s.slice(0, 4000) + '\n…(截断)' : s;
}
