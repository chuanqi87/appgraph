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
import { BackgroundComponentBrief, DataModelBrief, ModuleBrief, ScreenBrief } from './context';
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
}

/** How many split-unit member files to list verbatim before eliding. */
const MAX_LISTED_FILES = 40;

/** Render the full markdown brief for one migration unit. */
export function renderUnitBrief(
  unit: BriefUnit,
  modules: ModuleBrief[],
  totalUnits: number,
  contract?: UnitContract
): string {
  const lines: string[] = [];
  lines.push(`# 迁移工单 ${unit.order + 1}/${totalUnits} · ${unit.label}`);
  lines.push('');
  lines.push('> 由 `migrate plan` 从迁移图确定性生成。事实来源:[清单]=构建/清单文件(可直接信)·');
  lines.push('> [静态]=源码静态解析 · [启发]=代码图启发式(参考,需核实)。');
  lines.push('> 顺序为自底向上:本单元的声明依赖都排在更早的单元,应已先行迁移。');
  lines.push('');
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
  if (unit.kind === 'split' && unit.files) {
    const part = unit.featureSig === 'rest' ? '剩余部分(胶水/未聚类文件)' : '一个功能簇(M2 Feature 细分)';
    lines.push(`ℹ 本单元是模块的${part},只迁移下列 ${unit.files.length} 个文件;`);
    lines.push('  模块级事实(DI 装配/清单组件/能力)为全模块共享,列出仅供上下文。');
    for (const f of unit.files.slice(0, MAX_LISTED_FILES)) lines.push(`  - ${f}`);
    if (unit.files.length > MAX_LISTED_FILES) {
      lines.push(`  - …等共 ${unit.files.length} 个文件(全清单见 plan.json)`);
    }
    lines.push('');
  }

  for (const m of modules) renderModule(lines, m);
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

function renderModule(lines: string[], m: ModuleBrief): void {
  lines.push(`## 模块 ${m.moduleName}`);
  const meta = [
    m.role ? `角色 ${m.role}` : '',
    m.layer ? `层 ${m.layer}` : '',
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

  renderScreens(lines, m.screens);
  renderBackgroundComponents(lines, m.backgroundComponents);
  renderEntrypoints(lines, m);
  renderDataModels(lines, m.dataModels);
  renderDi(lines, m);
  renderFlows(lines, m);
  renderConstants(lines, m);
  renderCapabilities(lines, m);
  renderInterface(lines, m);
  renderTestContract(lines, m);
  renderDependencies(lines, m);
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
  }
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

function renderDataModels(lines: string[], models: DataModelBrief[]): void {
  if (models.length === 0) return;
  lines.push('### 数据模型 [静态](目标侧对应 relationalStore 表 / ArkTS interface)');
  for (const m of models) {
    const target =
      m.subtype === 'entity' ? `RDB 表${m.tableName ? ` \`${m.tableName}\`` : ''}` : 'ArkTS interface';
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

function renderDi(lines: string[], m: ModuleBrief): void {
  const di = m.di;
  if (!di) return;
  const hasContent = di.modules.length || di.provides.length || di.binds.length || di.injectionPoints.length;
  if (!hasContent) return;
  lines.push('### DI 装配 [静态](源侧 Hilt;HarmonyOS 无 DI 框架,需手动装配)');
  if (di.modules.length) {
    lines.push(`- Hilt 模块:${di.modules.join(', ')}${di.scopes.length ? ` · 作用域 ${di.scopes.join(', ')}` : ''}`);
  }
  if (di.provides.length) lines.push(`- @Provides 提供类型:${di.provides.join(', ')}`);
  for (const b of di.binds) lines.push(`- @Binds 绑定:\`${b.iface}\` ← \`${b.impl}\``);
  for (const p of di.injectionPoints) {
    lines.push(`- 注入点 \`${p.name}\`${p.injects.length ? ` 依赖:${p.injects.join(', ')}` : '(无构造依赖)'}`);
  }
  lines.push('');
}

function renderFlows(lines: string[], m: ModuleBrief): void {
  const flows = m.flows;
  if (!flows || (flows.exposedStates.length === 0 && flows.collectPoints === 0)) return;
  lines.push('### 响应式数据流 [静态](StateFlow/Flow/LiveData)');
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
    lines.push(`- SQL \`${q.sql}\`(Room @Query → 目标 relationalStore 须等价语义)`);
  }
  for (const e of c.enums) {
    lines.push(`- 枚举 \`${e.name}\` 取值:${e.values.map((v) => `\`${v}\``).join(', ')}(取值集须完整保留)`);
  }
  lines.push('');
}

function renderCapabilities(lines: string[], m: ModuleBrief): void {
  if (m.permissionCapabilities.length === 0 && m.capabilities.length === 0) return;
  lines.push('### 能力使用 → HarmonyOS 目标 API');
  if (m.permissionCapabilities.length > 0) {
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
  lines.push('### 依赖');
  if (m.dependencies.length === 0 && m.impliedDependencies.length === 0) {
    lines.push('_(无内部依赖,是叶子模块)_');
  }
  for (const d of m.dependencies) {
    lines.push(`- 声明依赖 [清单] **${d.moduleName}** — 公共成员:${d.publicMembers.join(', ') || '—'}`);
  }
  for (const d of m.impliedDependencies) {
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
      lines.push(`- [L1·auto] 公共接口:${iface.length} 个公开成员须有同名导出(逐条见契约文件)`);
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
