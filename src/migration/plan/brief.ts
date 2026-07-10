/**
 * P · brief renderer — render one migration unit's assembled facts into the
 * markdown work order an external migration agent consumes.
 *
 * The brief is a FACT SHEET + acceptance checklist, not a translation prompt:
 * it states what the source module IS (screens, schemas, DI, flows,
 * capabilities with their HarmonyOS target mapping), where to read the real
 * source (file anchors), and what "migrated" means (the verify criteria).
 * How to translate is the consuming agent's own concern.
 *
 * Every fact carries a provenance tag so the agent knows what to trust:
 * [清单] manifest/build-file fact · [静态] deterministic source parse ·
 * [启发] lifted heuristic (advisory).
 */

import { ContractCheck, UnitContract } from './contract';
import { BackgroundComponentBrief, ControlTree, CustomViewBrief, DataModelBrief, FeatureSectionBrief, ModuleBrief, ResourceBrief, ScreenBrief } from './context';
import { ControlNode } from '../../appgraph/detect/resources';
import { SqliteSchemaHint } from '../../appgraph/detect/sqldelight';
import { isNestedType, typePathKey } from '../../appgraph/qualified-name';

/** The unit shape the renderer needs (MigrationUnit and UnitPlan both satisfy it). */
export interface BriefUnit {
  order: number;
  label: string;
  cyclic: boolean;
  moduleIds: string[];
  /** 'merged' / 'split' render an explanatory header (absent = plain module unit). */
  kind?: 'module' | 'merged' | 'split';
  featureSig?: string;
  files?: string[];
  /** Parallel wave + direct prerequisite unit ids (plan schema ≥ 4). */
  wave?: number;
  dependsOnUnitIds?: string[];
  /** 'dev-only' when every member module is dev-support (benchmark/test/lint). */
  necessity?: string;
  /** Migration-size signals (P1-3) — symbol count and rough token estimate. */
  symbolCount?: number;
  estimatedTokens?: number;
}

/** How many split-unit member files to list verbatim before eliding. */
const MAX_LISTED_FILES = 40;
/** How many whole-module files to list verbatim (module/merged units) before eliding. */
const MAX_LISTED_MODULE_FILES = 200;
/** How many control-tree nodes to render per screen before eliding the rest (T2). */
const MAX_RENDERED_CONTROLS = 60;

/** `12345` → `12.3k`, keeping the rough estimate readable. */
function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Render the full markdown brief for one migration unit. */
export function renderUnitBrief(
  unit: BriefUnit,
  modules: ModuleBrief[],
  totalUnits: number,
  contract?: UnitContract,
  unitRefById?: Map<string, string>,
  /**
   * Set on a split SIBLING slice (not the module's first slice): the 1-based
   * unit number that fully lists this module's shared module-level facts. When
   * present, those sections render as a one-line pointer instead of the full
   * duplicated tables (T1-2).
   */
  moduleFactsRef?: string
): string {
  const lines: string[] = [];
  lines.push(`# 迁移工单 ${unit.order + 1}/${totalUnits} · ${unit.label}`);
  lines.push('');
  lines.push('> 由 `migrate plan` 从迁移图确定性生成。事实来源:[清单]=构建/清单文件(可直接信)·');
  lines.push('> [静态]=源码静态解析 · [启发]=代码图启发式(参考,需核实)。');
  lines.push('> 顺序为自底向上:本单元的声明依赖都排在更早的单元,应已先行迁移。');
  lines.push('');
  if (unit.symbolCount !== undefined && unit.estimatedTokens !== undefined) {
    lines.push(
      `规模:符号 ${unit.symbolCount} · 预计 ~${formatTokens(unit.estimatedTokens)} tokens(粗估,` +
        `供编排器判断是否需按功能簇拆分/选择模型上下文;非精确值)。`
    );
    lines.push('');
  }
  if (unit.wave !== undefined && unit.dependsOnUnitIds !== undefined) {
    const refs = unit.dependsOnUnitIds
      .map((id) => unitRefById?.get(id) ?? id)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    lines.push(
      refs.length === 0
        ? `**波次 ${unit.wave}** · 无前置单元,可立即开工(同波次单元可并行迁移)。`
        : `**波次 ${unit.wave}** · 前置单元:${refs.join('、')} —— 前置全部迁移完成后本单元即可开工;同波次单元可并行。`
    );
    lines.push('');
  }
  if (unit.necessity === 'dev-only') {
    lines.push(
      'ℹ 本单元是**开发支撑模块**(基准测试/测试工具/lint),不进产品包 —— 建议排在所有产品模块之后再迁移,或按需跳过。'
    );
    lines.push('');
  }
  if (unit.cyclic) {
    lines.push(`⚠ 本单元是依赖环(SCC):${modules.length} 个模块相互依赖,必须一并迁移。`);
    lines.push('');
  }
  if (unit.kind === 'merged') {
    lines.push(
      `ℹ 本单元由 ${modules.length} 个小模块聚合而成(按代码量装箱,相互无依赖约束),各模块事实分列如下,可一次迁移。`
    );
    lines.push('');
  }
  // A split sibling (not the module's first slice) points its shared module-level
  // facts at the first slice rather than re-listing them (T1-2).
  const showModuleFacts = !(unit.kind === 'split' && moduleFactsRef !== undefined);
  if (unit.kind === 'split' && unit.files) {
    const isRest = unit.featureSig === 'rest' || (unit.featureSig?.startsWith('rest:') ?? false);
    const part = isRest ? '剩余部分(胶水/未聚类文件,按包目录切分)' : '一个功能簇(M2 Feature 细分)';
    lines.push(`ℹ 本单元是模块的${part},只迁移下列 ${unit.files.length} 个文件;`);
    lines.push(
      showModuleFacts
        ? '  模块级事实(DI 装配/清单组件/能力)为全模块共享,列出仅供上下文。'
        : `  模块级事实(DI 装配/数据流/语义常量/资源/后台组件/权限/入口深链/行为契约)见本模块首片(单元 ${moduleFactsRef}),此处不重复。`
    );
    for (const f of unit.files.slice(0, MAX_LISTED_FILES)) lines.push(`  - ${f}`);
    if (unit.files.length > MAX_LISTED_FILES) {
      lines.push(`  - …等共 ${unit.files.length} 个文件(全清单见 plan.json)`);
    }
    lines.push('');
  }

  // A split unit already lists its exact slice files in the header above; a
  // module/merged unit migrates the whole module, so it gets the full manifest.
  for (const m of modules) renderModule(lines, m, unit.kind !== 'split', showModuleFacts);
  renderMcpGuide(lines, unit, modules);
  renderAcceptance(lines, modules, unit, contract);

  return lines.join('\n');
}

/**
 * Point the consuming agent at the `migrate serve --mcp` query surface.
 * Static text + deterministic interpolation only — briefs stay byte-stable.
 */
function renderMcpGuide(lines: string[], unit: BriefUnit, modules: ModuleBrief[]): void {
  const deps = [...new Set(modules.flatMap((m) => m.dependencies.map((d) => d.moduleName)))].sort();
  lines.push('## 在线查询(MCP)');
  lines.push('若已连接 `migrate serve --mcp`(server 名 migrate),迁移中可在线查询:');
  lines.push(`- 本单元工单与前置/后继:\`migrate_unit {"unit":"${unit.label}"}\``);
  if (deps.length > 0) {
    lines.push(
      `- 依赖模块的完整事实(接口/屏幕/能力):\`migrate_module_facts {"module":"${deps[0]}"}\`` +
        `(本单元依赖:${deps.join(', ')})`
    );
  } else if (modules.length > 0) {
    lines.push(`- 本模块完整事实:\`migrate_module_facts {"module":"${modules[0]!.moduleName}"}\``);
  }
  lines.push('- 迁移后核对缺口:先运行 `migrate verify <源> --target <目标>`,再 `migrate_verify_gaps {"module":"<模块名>"}`');
  lines.push('源码级问题(符号/调用链)用 codegraph MCP 的 `codegraph_explore`,或按文件锚点直接读源码。');
  lines.push('');
}

function renderModule(lines: string[], m: ModuleBrief, showFiles: boolean, showModuleFacts = true): void {
  lines.push(`## 模块 ${m.moduleName}`);
  const meta = [
    m.role ? `角色 ${m.role}` : '',
    m.layer ? `层 ${m.layer}` : '',
    m.necessity === 'dev-only' ? '开发支撑(建议延后)' : '',
    m.symbolCount !== undefined ? `符号 ${m.symbolCount} 个` : '',
  ].filter(Boolean);
  if (meta.length) lines.push(`- ${meta.join(' · ')}`);
  if (m.roleCounts && Object.keys(m.roleCounts).length > 0) {
    const counts = Object.entries(m.roleCounts)
      .map(([role, n]) => `${role}×${n}`)
      .join(' · ');
    lines.push(`- 组件角色分布 [静态]:${counts}`);
  }
  lines.push('');

  // Section order is unchanged; `showModuleFacts=false` (a split sibling slice)
  // just suppresses the un-sliceable module-level facts (DI / flows / constants /
  // background / entries+deep-links / permissions / test contract) — they are
  // rendered in full on the module's first slice, which the header points at (T1-2).
  if (showFiles) renderModuleFiles(lines, m);
  renderFeatureSections(lines, m.featureSections);
  renderScreens(lines, m.screens);
  renderCustomViews(lines, m.customViews);
  if (showModuleFacts) renderResources(lines, m.resources);
  if (showModuleFacts) renderBackgroundComponents(lines, m.backgroundComponents);
  if (showModuleFacts) renderEntrypoints(lines, m);
  renderDataModels(lines, m.dataModels);
  if (showModuleFacts) renderSqliteSchema(lines, m.sqliteSchema);
  if (showModuleFacts) renderDi(lines, m);
  if (showModuleFacts) renderFlows(lines, m);
  if (showModuleFacts) renderConstants(lines, m);
  renderCapabilities(lines, m, showModuleFacts);
  renderInterface(lines, m);
  if (showModuleFacts) renderTestContract(lines, m);
  renderDependencies(lines, m);
}

/**
 * The module's full file manifest (P1-3). The functional-cluster grouping below
 * only covers files that fell into a subdivision/cross-module Feature; this is
 * the complete list so no source file is invisible to the conversion agent.
 */
function renderModuleFiles(lines: string[], m: ModuleBrief): void {
  // Absent on a pre-P1-3 plan.json (additive field).
  if (!m.files || m.files.length === 0) return;
  lines.push(`### 文件清单 [静态](共 ${m.files.length} 个,本单元迁移整个模块)`);
  for (const f of m.files.slice(0, MAX_LISTED_MODULE_FILES)) lines.push(`- ${f}`);
  if (m.files.length > MAX_LISTED_MODULE_FILES) {
    lines.push(`- …等共 ${m.files.length} 个文件(全清单见 plan.json)`);
  }
  lines.push('');
}

function renderFeatureSections(lines: string[], sections: FeatureSectionBrief[] | undefined): void {
  // Absent on a pre-P1-3 plan.json (additive field).
  if (!sections || sections.length === 0) return;
  lines.push('### 功能簇分组 [启发](按 M2 聚类把本模块文件分组;大模块可按簇逐步迁移)');
  for (const s of sections) {
    const tag = s.weak ? ' ⚠低置信' : '';
    lines.push(`- **${s.name}**(${s.role} · 内聚 ${s.cohesion} · ${s.files.length} 文件)${tag}`);
    for (const f of s.files.slice(0, MAX_LISTED_FILES)) lines.push(`  - ${f}`);
    if (s.files.length > MAX_LISTED_FILES) {
      lines.push(`  - …等共 ${s.files.length} 个文件`);
    }
  }
  lines.push('  (簇为启发式聚类,边界可能不精确;仅作迁移分批参考,验收仍以模块公共接口为基线。)');
  lines.push('');
}

function renderScreens(lines: string[], screens: ScreenBrief[]): void {
  if (screens.length === 0) return;
  lines.push('### 屏幕 [静态](目标侧需有对应页面 + 路由)');
  for (const s of screens) {
    const via = s.subtype ? `(${s.subtype})` : '';
    lines.push(`- ${s.name}${via}${s.file ? ` — ${s.file}` : ''}`);
    if (s.navigatesTo.length > 0) {
      lines.push(`  - 导航至:${s.navigatesTo.join(', ')}`);
    }
    if (s.layouts.length > 0) {
      lines.push(`  - 关联布局 [静态]:${s.layouts.join(', ')}`);
    }
    renderControlTrees(lines, s.controls);
  }
  lines.push('');
}

/**
 * Render a screen's layout control tree(s) as an indented outline (T2). ArkUI
 * has no View inheritance, so the agent rebuilds each layout structurally as
 * `@Component`/`@Builder` — the tree gives it tag + id + key attributes to work
 * from. Bounded: at most `MAX_RENDERED_CONTROLS` nodes across the screen's
 * layouts, then a「…等 N 个控件」elision.
 */
function renderControlTrees(lines: string[], trees: ControlTree[] | undefined): void {
  if (!trees || trees.length === 0) return;
  const total = trees.reduce((sum, t) => sum + t.controlCount, 0);
  lines.push('  - 控件树 [静态](ArkUI 无 View 继承,按此结构用 @Component/@Builder 重写):');
  const budget = { remaining: MAX_RENDERED_CONTROLS };
  for (const tree of trees) {
    lines.push(`    - @layout/${tree.layout}(${tree.controlCount} 控件${tree.truncated ? ',源树已截断' : ''})`);
    renderControlNode(lines, tree.root, 3, budget);
    if (budget.remaining <= 0) break;
  }
  const rendered = MAX_RENDERED_CONTROLS - budget.remaining;
  if (total > rendered) {
    lines.push(`    - …等共 ${total} 个控件(完整控件树见 plan.json)`);
  }
}

/** One control node + its children, depth-indented, respecting the render budget. */
function renderControlNode(
  lines: string[],
  node: ControlNode,
  depth: number,
  budget: { remaining: number }
): void {
  if (budget.remaining <= 0) return;
  budget.remaining--;
  const indent = '  '.repeat(depth);
  const id = node.id ? ` #${node.id}` : '';
  const include = node.include ? ` → @layout/${node.include}` : '';
  const attrs = node.attrs
    ? ' (' +
      Object.entries(node.attrs)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([k, v]) => `${k}=${v}`)
        .join(', ') +
      ')'
    : '';
  const trunc = node.truncated ? ' …(子树略)' : '';
  lines.push(`${indent}- ${node.tag}${id}${attrs}${include}${trunc}`);
  for (const child of node.children ?? []) {
    if (budget.remaining <= 0) break;
    renderControlNode(lines, child, depth + 1, budget);
  }
}

/**
 * The module's XML resource inventory (T2) — the source-of-truth for the
 * target's `resources/base/element/*.json`. A module-level fact: suppressed on a
 * split sibling slice (see `showModuleFacts`).
 */
function renderResources(lines: string[], resources: ResourceBrief | undefined): void {
  if (!resources) return;
  const types = Object.entries(resources.byType)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t, n]) => `${t}×${n}`);
  if (types.length === 0 && resources.total === 0) return;
  lines.push('### 资源 [静态](目标侧对应 resources/base/element/*.json 与 media/)');
  lines.push(
    `- 共 ${resources.total} 条(来自 ${resources.fileCount} 个 values 文件)` +
      (types.length > 0 ? `:${types.join(' · ')}` : '')
  );
  if (resources.stringKeys.length > 0) {
    // The key list is a bounded SAMPLE (per-file + module caps), so an overflow
    // is a lower bound — never presented as a grand total (which would clash with
    // the per-locale `string×N` count above; distinct base keys are far fewer).
    const overflow =
      resources.stringKeyOverflow > 0 ? ` …另有 ${resources.stringKeyOverflow}+ 个键(样本已截断)` : '';
    lines.push(`- string 键样例:${resources.stringKeys.join(', ')}${overflow}(→ element/string.json)`);
  }
  lines.push('  string → element/string.json;color/dimen/style → element/color.json、float.json 等;图片资源(drawable/mipmap)→ media/。');
  lines.push('');
}

function renderCustomViews(lines: string[], views: CustomViewBrief[] | undefined): void {
  // Absent on a pre-P1-6 plan.json (the field is additive).
  if (!views || views.length === 0) return;
  lines.push('### 自定义 View [静态](ArkUI 无 UI 类继承 —— 需按组合/@Builder 重写,不可 1:1 翻译)');
  for (const v of views) {
    lines.push(`- ${v.name} extends ${v.superClass}${v.file ? ` — ${v.file}` : ''}`);
  }
  lines.push('  改写要点:继承的 View 子类 → \`@Component\` struct 或 \`@Builder\` 函数,自绘/measure/layout 逻辑迁到 ArkUI 布局与绘制 API。');
  lines.push('');
}

function renderBackgroundComponents(lines: string[], components: BackgroundComponentBrief[]): void {
  if (components.length === 0) return;
  lines.push('### 后台组件 [清单](目标侧对应 ExtensionAbility / 事件订阅)');
  for (const c of components) {
    const flags = [
      c.exported === true ? 'exported' : '',
      c.foregroundServiceType ? `前台服务(${c.foregroundServiceType})` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    lines.push(`- ${c.name}(${c.subtype})${flags ? ` — ${flags}` : ''}${c.file ? ` — ${c.file}` : ''}`);
    if (c.harmonyModule) {
      lines.push(`  - 目标:\`${c.harmonyModule}\`${c.harmonyNote ? ` — ${c.harmonyNote}` : ''}`);
    }
  }
  lines.push('');
}

function renderEntrypoints(lines: string[], m: ModuleBrief): void {
  if (m.appEntries.length === 0 && m.deeplinks.length === 0) return;
  lines.push('### 对外入口与深链 [清单]');
  if (m.appEntries.length > 0) {
    lines.push(`- 启动入口:${m.appEntries.join(', ')}(目标侧 EntryAbility + 首页路由)`);
  }
  if (m.deeplinks.length > 0) {
    lines.push(`- 深链:${m.deeplinks.join(', ')}(目标 module.json5 需声明对应 skills/uris)`);
  }
  lines.push('');
}

/** Table-backed data-model subtypes → a relationalStore table on the target. */
const RDB_TABLE_SUBTYPES = new Set(['entity', 'sqldelight-table', 'sqlite-table']);

function renderDataModels(lines: string[], models: DataModelBrief[]): void {
  if (models.length === 0) return;
  lines.push('### 数据模型 [静态](目标侧对应 relationalStore 表 / ArkTS interface)');
  for (const m of models) {
    const target = RDB_TABLE_SUBTYPES.has(m.subtype)
      ? `RDB 表${m.tableName ? ` \`${m.tableName}\`` : ''}`
      : 'ArkTS interface';
    lines.push(`#### ${m.name} → ${target}${m.file ? ` — ${m.file}` : ''}`);
    for (const f of m.fields) {
      const flags = [
        f.primaryKey ? 'PRIMARY KEY' : '',
        f.nullable ? 'nullable' : 'NOT NULL',
        f.mappedName ? `列名 ${f.mappedName}` : '',
      ]
        .filter(Boolean)
        .join(', ');
      lines.push(`- \`${f.name}: ${f.type}\`${flags ? ` (${flags})` : ''}`);
    }
  }
  lines.push('');
}

/** How many resolved column keys to list before eliding (bounded brief). */
const MAX_SQLITE_COLUMNS = 60;

/**
 * Handwritten-SQLite persistence hint (U3b). The `CREATE TABLE` schema is
 * assembled from `KEY_*`/`TABLE_NAME_*` constants that can't be statically
 * evaluated into a typed model, so this is a POINTER (table names + resolvable
 * column keys), explicitly heuristic — never a V2 entity acceptance check.
 */
function renderSqliteSchema(lines: string[], hint: SqliteSchemaHint | undefined): void {
  if (!hint || (hint.tables.length === 0 && hint.columns.length === 0)) return;
  lines.push('### 手写 SQLite 表 [启发](SQLiteOpenHelper;目标侧对应 relationalStore 表,schema 需按源码人工核对)');
  if (hint.files.length > 0) {
    lines.push(`- 建表位置:${hint.files.join(', ')}`);
  }
  if (hint.tables.length > 0) {
    lines.push(`- 表(${hint.tables.length}):${hint.tables.join(', ')}`);
  }
  if (hint.columns.length > 0) {
    const shown = hint.columns.slice(0, MAX_SQLITE_COLUMNS);
    const overflow =
      hint.columnsTruncated || hint.columns.length > MAX_SQLITE_COLUMNS
        ? ` …另有 ${Math.max(hint.columns.length - shown.length, 0)}+ 个列键(样本已截断)`
        : '';
    lines.push(`- 列键(从 KEY_* 常量解析,未按表拆分):${shown.join(', ')}${overflow}`);
  }
  lines.push('  说明:建表语句由常量拼接而成,无法静态求值出完整字段类型;迁移时请以源码 CREATE TABLE 为准。');
  lines.push('');
}

/** `manual` → 手工装配; a named framework passes through; absent → generic DI 框架. */
function diFrameworkLabel(framework: string | undefined): string {
  if (!framework) return 'DI 框架';
  return framework === 'manual' ? '手工装配' : framework;
}

function renderDi(lines: string[], m: ModuleBrief): void {
  const di = m.di;
  if (!di) return;
  const hasContent = di.modules.length || di.provides.length || di.binds.length || di.injectionPoints.length;
  if (!hasContent) return;
  // Framework is fingerprinted from the source imports (P3.2a) — no longer
  // hard-coded to Hilt, so Koin/Metro/manual projects read correctly.
  const fw = diFrameworkLabel(di.framework);
  lines.push(`### DI 装配 [静态](源侧 ${fw};HarmonyOS 无 DI 框架,需手动装配)`);
  if (di.modules.length) {
    lines.push(`- ${fw} 模块:${di.modules.join(', ')}${di.scopes.length ? ` · 作用域 ${di.scopes.join(', ')}` : ''}`);
  }
  if (di.provides.length) lines.push(`- @Provides 提供类型:${di.provides.join(', ')}`);
  for (const b of di.binds) {
    const via = b.via ?? '@Binds';
    const tag = b.multibinding ? ' [multibinding]' : '';
    lines.push(`- ${via} 绑定${tag}:\`${b.iface}\` ← \`${b.impl}\``);
  }
  for (const p of di.injectionPoints) {
    lines.push(`- 注入点 \`${p.name}\`${p.injects.length ? ` 依赖:${p.injects.join(', ')}` : '(无构造依赖)'}`);
  }
  lines.push('');
}

function renderFlows(lines: string[], m: ModuleBrief): void {
  const flows = m.flows;
  if (!flows || (flows.exposedStates.length === 0 && flows.collectPoints === 0)) return;
  lines.push('### 响应式数据流 [静态](StateFlow/Flow/LiveData/RxJava)');
  for (const s of flows.exposedStates) {
    lines.push(`- 暴露 \`${s.name}: ${s.flowKind}<${s.type}>\``);
  }
  if (flows.collectPoints > 0) {
    lines.push(`- 收集点 ${flows.collectPoints} 处(collectAsState/observeAsState/.collect)`);
  }
  lines.push('');
}

function renderConstants(lines: string[], m: ModuleBrief): void {
  const c = m.constants;
  if (!c) return;
  if (c.literals.length === 0 && c.routes.length === 0 && c.queries.length === 0 && c.enums.length === 0) {
    return;
  }
  lines.push('### 语义常量 [静态](L3 验收:以下字面量须在目标侧原样存活)');
  for (const lit of c.literals) {
    const tag = lit.kind === 'url' ? 'URL' : lit.kind === 'number' ? '数值' : '字符串';
    lines.push(`- ${tag} \`${lit.name}\` = \`${lit.value}\``);
  }
  for (const r of c.routes) {
    lines.push(`- 路由 \`${r.method} ${r.path}\`(Retrofit → 目标 HTTP 请求须同路径)`);
  }
  for (const q of c.queries) {
    // A clipped @Query can't be auto-verified byte-for-byte — flag manual review (T1-5c).
    const note = q.truncated ? ' ⚠SQL 截断,人工核对' : '';
    lines.push(`- SQL \`${q.sql}\`${note}(Room @Query → 目标 relationalStore 须等价语义)`);
  }
  for (const e of c.enums) {
    lines.push(`- 枚举 \`${e.name}\` 取值:${e.values.map((v) => `\`${v}\``).join(', ')}(取值集须完整保留)`);
  }
  lines.push('');
}

function renderCapabilities(lines: string[], m: ModuleBrief, showModuleFacts = true): void {
  // The import-derived API capabilities are per-slice; the permission-capability
  // line is module-level (manifest) and is suppressed on a split sibling (T1-2).
  const showPerms = showModuleFacts && m.permissionCapabilities.length > 0;
  if (!showPerms && m.capabilities.length === 0) return;
  lines.push('### 能力使用 → HarmonyOS 目标 API');
  if (showPerms) {
    lines.push(
      `- 权限能力 [清单]:${m.permissionCapabilities.join(', ')}(目标 module.json5 需声明对应 ohos.permission)`
    );
  }
  for (const c of m.capabilities) {
    lines.push(`#### ${c.id} [静态]`);
    if (c.harmony) {
      lines.push(`- 目标:\`${c.harmony.module}\``);
      lines.push(`- 要点:${c.harmony.note}`);
      for (const con of c.harmony.constructs ?? []) {
        lines.push(`  - \`${con.from}\` → \`${con.to}\``);
      }
    } else {
      lines.push('- (无内置目标 API 映射,需迁移方自行调研)');
    }
    lines.push(`- 证据(Android import):${c.evidence.join(', ')}`);
  }
  lines.push('');
}

function renderInterface(lines: string[], m: ModuleBrief): void {
  lines.push('### 公共接口 [静态](验收基线:同名导出应在目标侧存在)');
  if (m.publicInterface.length === 0) {
    lines.push('_(无公开类型/函数)_');
    lines.push('');
    return;
  }
  for (const member of m.publicInterface) {
    const vis = member.visibility ? `${member.visibility} ` : '';
    // ArkTS forbids nested type declarations: a nested type must be hoisted to a
    // top-level export, so its "same-named export" acceptance needs a rename.
    const nested = isNestedType(member.qualifiedName)
      ? `(嵌套类型 \`${typePathKey(member.qualifiedName)}\`:ArkTS 需提升为顶层导出,改名后按限定名登记 --export)`
      : '';
    lines.push(
      `- \`${vis}${member.kind} ${member.name}\`${member.signature ? ` — ${member.signature}` : ''}${nested} — ${member.file}`
    );
  }
  renderNameCollisions(lines, m);
  lines.push('');
}

/**
 * Warn when several public members share a simple name (e.g. three nested
 * `Action` enums). ArkTS forces each to a distinct top-level export, and verify
 * matches a bare-name rename only when the name is unique — so these MUST be
 * registered by their type-path (`--export "FeedEvent.Action=FeedEventAction"`)
 * or the acceptance check cannot tell them apart.
 */
function renderNameCollisions(lines: string[], m: ModuleBrief): void {
  const byName = new Map<string, string[]>();
  for (const member of m.publicInterface) {
    const list = byName.get(member.name) ?? [];
    list.push(typePathKey(member.qualifiedName));
    byName.set(member.name, list);
  }
  const collisions = [...byName.entries()].filter(([, paths]) => new Set(paths).size > 1);
  if (collisions.length === 0) return;
  lines.push('');
  lines.push('> ⚠ **同名导出冲突** — 以下裸名对应多个不同类型,目标侧须各自改成不同的顶层导出,');
  lines.push('> 且按限定名登记(裸名 `--export` 无法区分,verify 会当作歧义忽略):');
  for (const [name, paths] of collisions.sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`> - \`${name}\`:${[...new Set(paths)].sort().join(' / ')}`);
  }
}

function renderTestContract(lines: string[], m: ModuleBrief): void {
  const tc = m.testContract;
  if (!tc || tc.classes.length === 0) return;
  lines.push('### 行为契约 [静态](L4:要求在目标侧移植等价测试并自证通过)');
  for (const c of tc.classes) {
    const subject = c.subjectGuess ? ` → 被测对象 ${c.subjectGuess} [启发]` : '';
    lines.push(`- ${c.name}(${c.tests.length} 用例)${subject} — ${c.file}`);
  }
  lines.push('appgraph 不执行测试;此节为移植义务清单,完成情况由迁移方自证。');
  lines.push('');
}

function renderDependencies(lines: string[], m: ModuleBrief): void {
  // An implicit coupling with no weight AND no per-kind evidence is pure noise
  // — it renders「权重 0()」with empty parens and tells the agent nothing (T1-9b).
  const implied = m.impliedDependencies.filter(
    (d) => !(d.weight === 0 && Object.keys(d.byKind).length === 0)
  );
  lines.push('### 依赖');
  if (m.dependencies.length === 0 && implied.length === 0 && m.testDependencies.length === 0) {
    lines.push('_(无内部依赖,是叶子模块)_');
  }
  for (const d of m.dependencies) {
    lines.push(`- 声明依赖 [清单] **${d.moduleName}** — 公共成员:${d.publicMembers.join(', ') || '—'}`);
  }
  if (m.testDependencies.length > 0) {
    lines.push(
      `- 测试期依赖 [清单] ${m.testDependencies.map((n) => `**${n}**`).join('、')}` +
        `(testImplementation 等测试配置;不阻塞本单元迁移,移植测试时才需要)`
    );
  }
  for (const d of implied) {
    const kinds = Object.entries(d.byKind)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([k, n]) => `${k}×${n}`)
      .join(' · ');
    lines.push(`- 隐式耦合 [启发] **${d.moduleName}** — 权重 ${d.weight}(${kinds})`);
  }
  lines.push('');
}

/** Contract-driven acceptance section (falls back to the checklist without one). */
function renderAcceptance(
  lines: string[],
  modules: ModuleBrief[],
  unit: BriefUnit,
  contract?: UnitContract
): void {
  if (!contract || contract.checks.length === 0) {
    renderAcceptanceChecklist(lines, modules);
    return;
  }
  lines.push('## 验收契约(机器可核对)');
  lines.push('> 每条对应 `plan/contracts/` 契约中的一个 check(附 check id 前 8 位)。');
  lines.push('> auto 项由 `verify --unit` 自动判定;agent/info 项由迁移方人工核对,永不自动判失败。');
  lines.push('');

  const byModule = new Map<string, ContractCheck[]>();
  for (const c of contract.checks) {
    const list = byModule.get(c.moduleName) ?? [];
    list.push(c);
    byModule.set(c.moduleName, list);
  }
  for (const moduleName of [...byModule.keys()].sort()) {
    const checks = byModule.get(moduleName)!;
    lines.push(`### ${moduleName}`);
    const iface = checks.filter((c) => c.kind === 'interface');
    if (iface.length > 0) {
      lines.push(
        `- [L1·auto] 公共接口:${iface.length} 个公开成员须有同名导出` +
          `(${memberKindBreakdown(iface)};逐条见契约文件)`
      );
    }
    for (const c of checks.filter((c) => c.kind !== 'interface')) {
      lines.push(`- [${c.tier}·${c.verify}] ${kindLabel(c.kind)} ${c.subject} — ${c.expect} \`${c.id.slice(0, 8)}\``);
    }
    lines.push('');
  }
  lines.push(
    `运行 \`migrate verify <源工程> --target <目标工程> --unit "${unit.label}"\` 自动核对本单元 auto 项;`
  );
  lines.push('全量核对用不带 `--unit` 的 `migrate verify`。');
  lines.push('');
}

/** Fixed render order for the interface member-kind breakdown (deterministic). */
const MEMBER_KIND_ORDER: ReadonlyArray<ContractCheck['memberKind']> = [
  'interface',
  'class',
  'enum',
  'function',
];

/** 中文 label for a real public-member kind (T1-4 memberKind display). */
function memberKindLabel(kind: ContractCheck['memberKind']): string {
  switch (kind) {
    case 'class':
      return '类';
    case 'enum':
      return '枚举';
    case 'function':
      return '函数';
    case 'interface':
      return '接口';
    default:
      return '接口'; // pre-memberKind plan.json — the old aggregate label
  }
}

/**
 * Per-real-kind breakdown of the interface checks, e.g. `类×2 · 枚举×1`. The
 * check kind is uniformly 'interface' (stable id), so this reads `memberKind` —
 * a class member shows as「类」rather than being lumped under「接口」(T1-4).
 */
function memberKindBreakdown(iface: ContractCheck[]): string {
  const counts = new Map<ContractCheck['memberKind'], number>();
  for (const c of iface) {
    const k = c.memberKind ?? 'interface';
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const k of MEMBER_KIND_ORDER) {
    const n = counts.get(k);
    if (n) parts.push(`${memberKindLabel(k)}×${n}`);
  }
  // Any unexpected kind (should not occur — INTERFACE_KINDS is closed) sorts last.
  for (const [k, n] of [...counts.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
    if (!MEMBER_KIND_ORDER.includes(k)) parts.push(`${memberKindLabel(k)}×${n}`);
  }
  return parts.join(' · ');
}

/** Human-readable label for a contract check kind. */
function kindLabel(kind: ContractCheck['kind']): string {
  const labels: Record<ContractCheck['kind'], string> = {
    interface: '接口',
    screen: '屏幕',
    model: '数据模型',
    capability: '能力',
    background: '后台组件',
    'nav-edge': '导航边',
    'di-binding': 'DI 绑定',
    constant: '常量',
    route: '路由',
    query: 'SQL',
    'enum-values': '枚举取值',
    deeplink: '深链',
    state: '状态',
    test: '测试',
  };
  return labels[kind];
}

/** Legacy checklist rendering (no contract available — e.g. an old plan.json). */
function renderAcceptanceChecklist(lines: string[], modules: ModuleBrief[]): void {
  lines.push('## 验收清单');
  for (const m of modules) {
    const caps = [
      ...new Set([...m.permissionCapabilities, ...m.capabilities.map((c) => c.id)]),
    ].sort();
    lines.push(`### ${m.moduleName}`);
    if (m.publicInterface.length > 0) {
      lines.push(`- [ ] T3 · 公共接口:${m.publicInterface.length} 个公开成员在目标侧有对应导出`);
    }
    if (m.screens.length > 0) {
      lines.push(`- [ ] V1 · 屏幕:${m.screens.map((s) => s.name).join(', ')} 在目标侧有对应页面`);
    }
    if (m.dataModels.length > 0) {
      lines.push(`- [ ] V2 · 数据模型:${m.dataModels.map((d) => d.name).join(', ')} 字段级对齐`);
    }
    if (caps.length > 0) {
      lines.push(`- [ ] 能力覆盖:${caps.join(', ')} 在目标侧出现`);
    }
    if (m.backgroundComponents.length > 0) {
      lines.push(
        `- [ ] 后台组件:${m.backgroundComponents.map((c) => c.name).join(', ')} 在目标侧有对应 Ability/订阅`
      );
    }
    if (m.deeplinks.length > 0) {
      lines.push(`- [ ] 深链:${m.deeplinks.join(', ')} 已在目标 module.json5 声明`);
    }
  }
  lines.push('');
  lines.push('迁移完成后运行 `migrate verify <源工程> --target <目标工程>` 自动核对以上各项。');
  lines.push('');
}
