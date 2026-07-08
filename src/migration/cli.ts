#!/usr/bin/env node
/**
 * migrate — CLI for the SOURCE-SIDE migration analysis graph.
 *
 * appgraph analyzes the Android source project and hands the result to an
 * EXTERNAL migration agent; it does not translate code itself. Pipeline (each
 * stage reads the previous graph JSON and augments it in place):
 *   migrate index        <root>   build/refresh the codegraph code-symbol index
 *   migrate modules      <root>   M1 · ArchModule + depends_on (declared ∪ lifted)
 *   migrate community    <root>   M2 · deterministic Feature clusters
 *   migrate capabilities <root>   M3 · uses_capability + HarmonyOS target APIs
 *   migrate semantics    <root>   U  · roles/screens/entities/DI/flows/resources
 *   migrate order        <root>   M3 · bottom-up unit order (SCC condensation)
 *   migrate plan         <root>   P  · per-unit work-order briefs (the hand-off)
 *   migrate verify       <root> --target <dir>   acceptance gate on the migrated project
 *   migrate sync         <root>   I1 · incremental refresh + change report
 */

import * as path from 'node:path';
import { Command } from 'commander';
import { CodeGraph } from '../index';
import { CodeSymbolGraph } from '../appgraph/graph-reader';
import { buildModuleDependencyGraph } from '../appgraph/modules';
import { buildCommunityOverlay } from '../appgraph/community';
import { computeMigrationOrder } from './order/topo';
import { detectCapabilities } from './capabilities-ext';
import { detectManifestCapabilities, ModuleRef } from '../appgraph/detect/manifest-capabilities';
import { buildSemantics } from '../appgraph/detect/semantics';
import { assignNodesToModules } from '../appgraph/modules/assign';
import { AppNode } from '../appgraph/schema';
import { buildMigrationPlan, writeMigrationPlan, MigrationPlan } from './plan';
import { UnitContract } from './plan/contract';
import { resolveUnit } from './plan/resolve';
import { MigrateMcpServer } from './mcp/server';
import { verifyMigration } from './verify/diff';
import { countStatePatterns, loadTargetSources } from './verify/semantic-scan';
import { verifyUnit, UnitVerifyReport } from './verify/unit';
import {
  assertTransition,
  emptyLedger,
  LedgerEntry,
  LedgerStatus,
  readLedger,
  writeLedger,
} from './ledger';
import { getLedgerPath, getPlanDir, getVerifyUnitsDir } from './paths';
import { diffMigrationGraphs, MigrationDiff } from './incremental';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  emptyMigrationGraph,
  mergeInto,
  MigrationGraph,
} from './types';
import { canonicalJson } from '../appgraph/serialize';
import {
  hashMigrationGraph,
  migrationGraphPath,
  readMigrationGraph,
  writeMigrationGraph,
} from './serialize';

/** Load the project's migration graph, or start a fresh Android→Harmony one. */
function loadOrInit(outPath: string, root: string, packageName: string): MigrationGraph {
  return (
    readMigrationGraph(outPath) ??
    emptyMigrationGraph({ platform: 'android', app: { name: path.basename(root), packageName } })
  );
}

async function cmdIndex(pathArg: string): Promise<void> {
  const root = path.resolve(pathArg);
  const cg = CodeGraph.isInitialized(root)
    ? await CodeGraph.open(root, { sync: true })
    : await CodeGraph.init(root, { index: true });
  try {
    const stats = cg.getStats();
    console.log(
      `索引完成:${stats.nodeCount} 节点 / ${stats.edgeCount} 边 / ${stats.fileCount} 文件`
    );
  } finally {
    cg.close();
  }
}

function cmdModules(pathArg: string, options: { out?: string }): void {
  const root = path.resolve(pathArg);
  const outPath = options.out ? path.resolve(options.out) : migrationGraphPath(root);
  const reader = CodeSymbolGraph.open(root);
  try {
    const result = buildModuleDependencyGraph(root, reader);
    const graph = loadOrInit(outPath, root, result.packageName ?? '');
    if (result.packageName) graph.source.app.packageName = result.packageName;
    mergeInto(graph, { nodes: result.nodes, edges: result.edges, warnings: result.warnings });
    writeMigrationGraph(outPath, graph);

    const { stats } = result;
    console.log(`M1 模块依赖图 → ${path.relative(process.cwd(), outPath)}`);
    console.log(
      `  模块 ${stats.moduleCount} · depends_on 声明 ${stats.declaredDeps}` +
        `(补出 lifted ${stats.liftedDeps} · 增强 ${stats.enrichedDeps})`
    );
    console.log(
      `  符号归属 ${stats.assignedNodes} · 未归属 ${stats.unassignedNodes}` +
        ` · 覆盖警告 ${result.warnings.length}`
    );
    printTopModules(result);
    console.log(`  图指纹 ${hashMigrationGraph(graph).slice(0, 16)}`);
  } finally {
    reader.close();
  }
}

function cmdCommunity(pathArg: string, options: { out?: string }): void {
  const root = path.resolve(pathArg);
  const outPath = options.out ? path.resolve(options.out) : migrationGraphPath(root);
  const graph = readMigrationGraph(outPath);
  if (!graph) {
    throw new Error(`未找到迁移图 ${outPath},请先运行 “migrate modules ${pathArg}”`);
  }
  const archModules = graph.nodes.filter((n) => n.kind === 'ArchModule');
  if (archModules.length === 0) {
    throw new Error(`迁移图缺少 ArchModule 节点,请先运行 “migrate modules ${pathArg}”`);
  }

  const reader = CodeSymbolGraph.open(root);
  try {
    const result = buildCommunityOverlay(archModules, reader);
    mergeInto(graph, { nodes: result.nodes, edges: result.edges, warnings: result.warnings });
    writeMigrationGraph(outPath, graph);

    const { stats } = result;
    console.log(`M2 社区检测 → ${path.relative(process.cwd(), outPath)}`);
    console.log(
      `  Feature ${stats.featureCount}(细分 ${stats.subdivision} · 跨模块 ${stats.crossModule}` +
        ` · 对齐 ${stats.aligned})· 参与耦合文件 ${stats.coupledFiles}`
    );
    printTopFeatures(result);
    console.log(`  图指纹 ${hashMigrationGraph(graph).slice(0, 16)}`);
  } finally {
    reader.close();
  }
}

/** Map each code node id to its owning ArchModule id, via the M1 assignment. */
function nodeToModuleId(archModules: AppNode[], reader: CodeSymbolGraph): Map<string, string> {
  const moduleDirToId = new Map<string, string>();
  const moduleDirs: string[] = [];
  for (const m of archModules) {
    const dir = typeof m.attrs?.dir === 'string' ? m.attrs.dir : undefined;
    if (dir !== undefined) {
      moduleDirToId.set(dir, m.id);
      moduleDirs.push(dir);
    }
  }
  const assignment = assignNodesToModules(reader.getAllNodes(), moduleDirs);
  const map = new Map<string, string>();
  for (const [nid, dir] of assignment.nodeToModuleDir) {
    const mid = moduleDirToId.get(dir);
    if (mid) map.set(nid, mid);
  }
  return map;
}

function cmdCapabilities(pathArg: string, options: { out?: string }): void {
  const root = path.resolve(pathArg);
  const outPath = options.out ? path.resolve(options.out) : migrationGraphPath(root);
  const graph = readMigrationGraph(outPath);
  if (!graph) {
    throw new Error(`未找到迁移图 ${outPath},请先运行 “migrate modules ${pathArg}”`);
  }
  const archModules = graph.nodes.filter((n) => n.kind === 'ArchModule');
  if (archModules.length === 0) {
    throw new Error(`迁移图缺少 ArchModule 节点,请先运行 “migrate modules ${pathArg}”`);
  }

  const reader = CodeSymbolGraph.open(root);
  try {
    // API/framework capabilities from `import` FQNs (phase-1).
    const api = detectCapabilities(reader.getAllNodes(), nodeToModuleId(archModules, reader));
    mergeInto(graph, { nodes: api.capabilityNodes, edges: api.edges });

    // S1 · permission-backed capabilities from AndroidManifest (phase-2 gap).
    const manifest = detectManifestCapabilities(root, moduleRefs(archModules));
    mergeInto(graph, {
      nodes: [...manifest.permissionNodes, ...manifest.capabilityNodes],
      edges: manifest.usesEdges,
      warnings: manifest.warnings,
    });
    writeMigrationGraph(outPath, graph);

    const capNames = new Set<string>([
      ...api.capabilityNodes.map((n) => n.name),
      ...manifest.capabilityNodes.map((n) => n.name),
    ]);
    console.log(`M3 能力标注 → ${path.relative(process.cwd(), outPath)}`);
    console.log(
      `  API 能力 ${api.stats.capabilityCount} 种 · uses_capability ${api.stats.usesEdges} 条 · 覆盖模块 ${api.stats.taggedModules}`
    );
    console.log(
      `  权限能力(S1)${manifest.stats.capabilityCount} 种 · Permission ${manifest.stats.permissionCount} 个` +
        ` · manifest ${manifest.stats.manifestCount} 份 · uses_capability ${manifest.stats.usesEdges} 条`
    );
    for (const name of [...capNames].sort()) {
      const target =
        api.capabilityNodes.find((n) => n.name === name) ??
        manifest.capabilityNodes.find((n) => n.name === name);
      console.log(`    · ${name} → ${target?.attrs?.harmonyModule ?? '(无目标 API 映射)'}`);
    }
    console.log(`  图指纹 ${hashMigrationGraph(graph).slice(0, 16)}`);
  } finally {
    reader.close();
  }
}

function cmdSemantics(pathArg: string, options: { out?: string }): void {
  const root = path.resolve(pathArg);
  const outPath = options.out ? path.resolve(options.out) : migrationGraphPath(root);
  const graph = readMigrationGraph(outPath);
  if (!graph) {
    throw new Error(`未找到迁移图 ${outPath},请先运行 “migrate modules ${pathArg}”`);
  }
  const archModules = graph.nodes.filter((n) => n.kind === 'ArchModule');
  if (archModules.length === 0) {
    throw new Error(`迁移图缺少 ArchModule 节点,请先运行 “migrate modules ${pathArg}”`);
  }

  const reader = CodeSymbolGraph.open(root);
  try {
    const result = buildSemantics(reader, root, archModules, nodeToModuleId(archModules, reader));
    mergeInto(graph, { nodes: result.nodes, edges: result.edges, warnings: result.warnings });
    writeMigrationGraph(outPath, graph);

    const s = result.stats;
    console.log(`U 源侧语义深化 → ${path.relative(process.cwd(), outPath)}`);
    console.log(`  U1 角色标注 ${s.rolesTagged} 个符号 · U2 Compose 屏幕 ${s.screens} + navigates_to ${s.navEdges} 条`);
    console.log(`  U3 数据模型 ${s.dataModels} 个(含字段 schema)· U4 DI 模块 ${s.diModules} · 布线边 ${s.diWiredEdges}`);
    console.log(`  U5 暴露响应式状态 ${s.exposedStates} 个 · U6 资源文件 ${s.resourceFiles} + XML-View 屏幕 ${s.layoutScreens}`);
    console.log(
      `  S2 Activity 屏幕 ${s.activityScreens} · 后台组件 ${s.backgroundComponents}` +
        ` · 启动入口 ${s.appEntries} · 深链 ${s.deeplinks}`
    );
    console.log(
      `  S2 Intent 导航 ${s.intentNavEdges} 条 · backed_by ${s.backedByEdges} 条` +
        ` · 布局宿主关联 ${s.layoutLinks} 条`
    );
    console.log(
      `  U7 语义常量:字面量 ${s.constantLiterals} · 路由 ${s.constantRoutes}` +
        ` · SQL ${s.constantQueries} · 枚举 ${s.constantEnums}`
    );
    console.log(`  E 测试契约(L4):测试类 ${s.testClasses} · 用例 ${s.testCases}(仅提取,不执行)`);
    console.log(`  覆盖警告 ${s.warnings} 条 · 图指纹 ${hashMigrationGraph(graph).slice(0, 16)}`);
  } finally {
    reader.close();
  }
}

/** ArchModule nodes → the {id,name,dir} refs the manifest attributor needs. */
function moduleRefs(archModules: AppNode[]): ModuleRef[] {
  const refs: ModuleRef[] = [];
  for (const m of archModules) {
    const dir = typeof m.attrs?.dir === 'string' ? m.attrs.dir : undefined;
    if (dir !== undefined) refs.push({ id: m.id, name: m.name, dir });
  }
  return refs;
}

function parsePositiveInt(value: string, flag: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${flag} 需要一个正整数,收到 “${value}”`);
  }
  return n;
}

interface PlanCliOptions {
  out?: string;
  minUnitSymbols?: string;
  maxUnitSymbols?: string;
  /** commander's --no-unit-planning lands here as false. */
  unitPlanning?: boolean;
}

function cmdPlan(pathArg: string, options: PlanCliOptions): void {
  const root = path.resolve(pathArg);
  const outPath = options.out ? path.resolve(options.out) : migrationGraphPath(root);
  const graph = readMigrationGraph(outPath);
  if (!graph) {
    throw new Error(`未找到迁移图 ${outPath},请先运行 “migrate modules ${pathArg}”`);
  }
  if (!graph.order) {
    throw new Error(`迁移图缺少迁移顺序,请先运行 “migrate order ${pathArg}”`);
  }

  const reader = CodeSymbolGraph.open(root);
  try {
    const { plan, publicInterfaceByModule, contracts } = buildMigrationPlan(graph, reader, {
      enabled: options.unitPlanning !== false,
      ...(options.minUnitSymbols !== undefined
        ? { minUnitSymbols: parsePositiveInt(options.minUnitSymbols, '--min-unit-symbols') }
        : {}),
      ...(options.maxUnitSymbols !== undefined
        ? { maxUnitSymbols: parsePositiveInt(options.maxUnitSymbols, '--max-unit-symbols') }
        : {}),
    });
    const planDir = writeMigrationPlan(root, plan, contracts);

    // Persist each source module's public surface on its ArchModule node —
    // the T3 interface-fidelity baseline `migrate verify` checks against.
    const enriched = graph.nodes
      .filter((n) => n.kind === 'ArchModule' && publicInterfaceByModule.has(n.id))
      .map((n) => ({
        ...n,
        attrs: { ...n.attrs, publicInterface: publicInterfaceByModule.get(n.id)! },
      }));
    mergeInto(graph, { nodes: enriched });
    writeMigrationGraph(outPath, graph);

    const moduleCount = plan.units.reduce((n, u) => n + u.modules.length, 0);
    const screens = plan.units.reduce(
      (n, u) => n + u.modules.reduce((m, b) => m + b.screens.length, 0),
      0
    );
    const models = plan.units.reduce(
      (n, u) => n + u.modules.reduce((m, b) => m + b.dataModels.length, 0),
      0
    );
    const checkCount = [...contracts.values()].reduce((n, c) => n + c.checks.length, 0);
    console.log(`P 迁移工单 → ${path.relative(process.cwd(), planDir)}`);
    console.log(
      `  单元 ${plan.totalUnits}(自底向上)· 模块 ${moduleCount} · 屏幕 ${screens} · 数据模型 ${models}`
    );
    console.log(`  验收契约 ${contracts.size} 份 · check ${checkCount} 条(plan/contracts/)`);
    console.log(`  应用装配工单 → ${plan.appScaffold.briefFile}(全局路由表/权限/入口,跨单元)`);
    if (plan.planning.enabled) {
      console.log(
        `  单元计划:聚合收敛 ${plan.planning.merged} 个 · 拆分 ${plan.planning.split} 个大模块` +
          `(阈值 ${plan.planning.minUnitSymbols}–${plan.planning.maxUnitSymbols} 符号)`
      );
    }
    for (const unit of plan.units.slice(0, 8)) {
      const mark = unit.cyclic ? ' [SCC]' : unit.kind === 'merged' ? ' [聚合]' : unit.kind === 'split' ? ' [拆分]' : '';
      console.log(`    ${String(unit.order + 1).padStart(2)}. ${unit.label}${mark} → ${unit.briefFile}`);
    }
    if (plan.units.length > 8) console.log(`    …共 ${plan.units.length} 个单元,详见 plan.json`);
    console.log(`  图指纹 ${hashMigrationGraph(graph).slice(0, 16)}`);
  } finally {
    reader.close();
  }
}

async function cmdVerify(pathArg: string, options: { out?: string; target?: string; unit?: string }): Promise<void> {
  const root = path.resolve(pathArg);
  const outPath = options.out ? path.resolve(options.out) : migrationGraphPath(root);
  if (!options.target) {
    throw new Error('缺少 --target <目标工程路径>:verify 校验的是外部 agent 迁移出的 HarmonyOS 工程');
  }
  if (options.unit !== undefined) {
    await cmdVerifyUnit(root, outPath, options.target, options.unit);
    return;
  }
  const graph = readMigrationGraph(outPath);
  if (!graph) {
    throw new Error(`未找到迁移图 ${outPath},请先运行完整流程(modules → capabilities → order → plan)`);
  }

  // T3 interface scoping + rename matching read the ledger (if the agent
  // registered target paths / renames); absent → the module-name heuristic.
  const ledger = readLedger(getLedgerPath(root));
  const plan = readJsonFile<MigrationPlan>(path.join(getPlanDir(root), 'plan.json'));
  const result = await verifyMigration(graph, path.resolve(options.target), ledger, plan);
  mergeInto(graph, { nodes: result.targetNodes, edges: result.mapsToEdges });
  writeMigrationGraph(outPath, graph);

  const reportPath = path.join(path.dirname(outPath), 'verify-report.json');
  // The FULL acceptance document (capability coverage + T3/T4/V1/V2) — the
  // migrate MCP `migrate_verify_gaps` tool reads this shape.
  const reportDoc = {
    method: result.method,
    fileCount: result.fileCount,
    report: result.report,
    structural: result.structural,
    fidelity: result.fidelity,
    screenDiff: result.screenDiff,
    entityDiff: result.entityDiff,
    navDiff: result.navDiff,
    diBindingDiff: result.diBindingDiff,
    unverifiable: result.unverifiable,
  };
  writeFileSync(reportPath, JSON.stringify(reportDoc, null, 2) + '\n', 'utf8');

  const { report } = result;
  const methodLabel = 'CodeGraph 符号级 (tree-sitter)';
  console.log(`M4 迁移验证 → ${path.relative(process.cwd(), reportPath)}`);
  console.log(`  解析方式 ${methodLabel} · 生成物 ${result.fileCount} 个文件 · 目标节点 ${result.targetNodes.length}`);
  if (result.structural) {
    const s = result.structural;
    console.log(
      `  T4 结构校验 buildOk=${s.buildOk} · 类 ${s.classCount} · 方法 ${s.methodCount}` +
        ` · 目标能力 ${s.capabilityIds.length} 种`
    );
  }
  console.log(
    `  能力覆盖 ${(report.capabilityCoverage * 100).toFixed(0)}%` +
      `(matched ${report.capabilities.matched.length} · 缺口 ${report.capabilities.missingInTarget.length})`
  );
  if (report.gaps.length > 0) {
    console.log('  迁移缺口(missingInTarget):');
    for (const g of report.gaps) console.log(`    ! [${g.severity}] ${g.id} — ${g.detail}`);
  } else {
    console.log('  无能力遗漏 ✓');
  }
  const fidelityGaps = result.fidelity.filter((f) => f.missing.length > 0);
  if (result.fidelity.length > 0) {
    console.log(
      `  T3 接口 fidelity:${result.fidelity.length} 模块 · 有缺失 ${fidelityGaps.length} 个`
    );
    for (const f of fidelityGaps.slice(0, 8)) {
      console.log(
        `    ! ${f.moduleName} 缺 ${f.missing.length}/${f.sourceCount}:${f.missing.slice(0, 5).join(', ')}`
      );
    }
  }

  const sd = result.screenDiff;
  console.log(
    `  V1 屏幕 fidelity:源 ${sd.sourceCount} ↔ 目标 ${sd.targetCount} · 匹配 ${sd.matched.length}` +
      ` · missingInTarget ${sd.missingInTarget.length}`
  );
  if (sd.missingInTarget.length > 0) {
    console.log(`    ! 目标缺屏幕:${sd.missingInTarget.slice(0, 8).join(', ')}`);
  }
  const ed = result.entityDiff;
  const fullChecked = ed.models.filter((m) => m.fieldCheck === 'full').length;
  const nameOnly = ed.models.filter((m) => m.fieldCheck === 'name-only').length;
  console.log(
    `  V2 实体 schema fidelity:模型 ${ed.models.length} · 目标缺 ${ed.modelsMissing}` +
      ` · 字段级校验 ${fullChecked}(仅名称匹配 ${nameOnly})· 字段缺 ${ed.fieldsMissing}`
  );
  for (const m of ed.models.filter((m) => !m.present || m.missingFields.length > 0).slice(0, 8)) {
    const detail = !m.present
      ? '目标无对应类'
      : `缺字段 ${m.missingFields.length}/${m.sourceFields}:${m.missingFields.slice(0, 5).join(', ')}`;
    console.log(`    ! ${m.name} — ${detail}`);
  }
  const nd = result.navDiff;
  console.log(
    `  L2 导航拓扑:源边 ${nd.sourceCount} · 匹配 ${nd.matched.length}` +
      ` · 目标缺边 ${nd.missingInTarget.length} · 端点缺失跳过 ${nd.skippedEndpointMissing.length}`
  );
  for (const e of nd.missingInTarget.slice(0, 6)) {
    console.log(`    ! 缺导航 ${e.from} → ${e.to}`);
  }
  const dd = result.diBindingDiff;
  if (dd.total > 0) {
    console.log(`  L2 DI 绑定:${dd.total} 条 · 双端存在 ${dd.matched} · 缺 ${dd.missing.length}(只验存在,不验装配)`);
    for (const b of dd.missing.slice(0, 6)) {
      console.log(`    ! ${b.iface} ← ${b.impl} 缺:${b.missingEnds.join(', ')}`);
    }
  }
  if (result.unverifiable.length > 0) {
    console.log(`  未自动校验(构造映射):${result.unverifiable.join(', ')}`);
  }
  const stateCount = countStatePatterns(loadTargetSources(path.resolve(options.target)));
  console.log(`  D3 目标响应式状态标记(@State/@Observed/@Track/AppStorage)${stateCount} 处(info,不判 fail)`);
  console.log(`  maps_to(能力级)${result.mapsToEdges.length} 条 · 图指纹 ${hashMigrationGraph(graph).slice(0, 16)}`);
}

/** `verify --unit <unit>` — per-unit gate: no full report, no graph merge. */
async function cmdVerifyUnit(root: string, outPath: string, targetRoot: string, unitQuery: string): Promise<void> {
  const graph = readMigrationGraph(outPath);
  if (!graph) {
    throw new Error(`未找到迁移图 ${outPath},请先运行完整流程(modules → … → plan)`);
  }
  const plan = readJsonFile<MigrationPlan>(path.join(getPlanDir(root), 'plan.json'));
  if (!plan) {
    throw new Error('未找到 plan.json,请先运行 “migrate plan”');
  }
  const unit = resolveUnit(plan, unitQuery);
  const isScaffold = !unit && ['0', 'scaffold', 'app-scaffold'].includes(unitQuery.trim().toLowerCase());
  if (!unit && !isScaffold) {
    throw new Error(`未找到迁移单元 “${unitQuery}”(可用 1 起序号 / id / 标签 / 模块名 / scaffold)`);
  }
  const contractRel = unit ? unit.contractFile : plan.appScaffold.contractFile;
  const contract = readJsonFile<UnitContract>(path.join(getPlanDir(root), contractRel));
  if (!contract) {
    throw new Error(`未找到契约 ${contractRel},请重跑 “migrate plan”`);
  }
  const ledger = readLedger(getLedgerPath(root));
  const report = await verifyUnit(graph, plan, contract, path.resolve(targetRoot), ledger);

  const reportPath = path.join(getVerifyUnitsDir(root), `${report.unitId}.json`);
  mkdirSync(getVerifyUnitsDir(root), { recursive: true });
  writeFileSync(reportPath, canonicalJson(report) + '\n', 'utf8');
  printUnitReport(report, reportPath);
}

function printUnitReport(report: UnitVerifyReport, reportPath: string): void {
  const s = report.summary;
  const methodLabel = 'CodeGraph 符号级 (tree-sitter)';
  console.log(`M4 单元验收 ${report.unitLabel} → ${path.relative(process.cwd(), reportPath)}`);
  console.log(`  解析方式 ${methodLabel} · 作用域 ${report.scope}`);
  console.log(
    `  check ${s.total}:通过 ${s.pass} · 失败 ${s.fail} · 跳过 ${s.skipped} · 提示 ${s.info}`
  );
  const fails = report.checks.filter((c) => c.status === 'fail');
  const deps = report.checks.filter((c) => c.gapClass === 'dependency-missing');
  const pending = report.checks.filter((c) => c.gapClass === 'not-migrated');
  if (fails.length > 0) {
    console.log('  真实缺口(本单元已登记迁移却缺失 unit-missing):');
    for (const c of fails.slice(0, 12)) {
      const ev = c.evidence && c.evidence.length ? ` — 缺 ${c.evidence.slice(0, 5).join(', ')}` : '';
      console.log(`    ! [${c.tier}] ${c.kind} ${c.subject}${ev}  ${c.id.slice(0, 8)}`);
    }
  }
  if (deps.length > 0) {
    console.log(`  依赖未就绪(dependency-missing)${deps.length} 条:先迁移其依赖单元`);
  }
  if (pending.length > 0) {
    console.log(`  本单元尚未登记迁移(not-migrated)${pending.length} 条:非缺口,登记后再验`);
  }
  if (s.fail === 0 && s.skipped === 0) {
    console.log('  本单元 auto 项全部通过 ✓(agent/info 项见报告)');
  }
}

/** Read a JSON artifact, or null when it doesn't exist / can't be parsed. */
function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function cmdOrder(pathArg: string, options: { out?: string; includeLifted?: boolean }): void {
  const root = path.resolve(pathArg);
  const outPath = options.out ? path.resolve(options.out) : migrationGraphPath(root);
  const graph = readMigrationGraph(outPath);
  if (!graph) {
    throw new Error(`未找到迁移图 ${outPath},请先运行 “migrate modules ${pathArg}”`);
  }
  const modules = graph.nodes.filter((n) => n.kind === 'ArchModule');
  if (modules.length === 0) {
    throw new Error(`迁移图缺少 ArchModule 节点,请先运行 “migrate modules ${pathArg}”`);
  }

  const result = computeMigrationOrder(modules, graph.edges, { includeLifted: options.includeLifted });
  graph.order = result.order;
  writeMigrationGraph(outPath, graph);

  const { stats } = result;
  console.log(`M3 迁移顺序 → ${path.relative(process.cwd(), outPath)}`);
  console.log(
    `  排序依据:${options.includeLifted ? '声明+隐式' : '声明依赖(DAG 骨架)'} · ${stats.edgesUsed} 条 depends_on`
  );
  console.log(
    `  迁移单元 ${stats.unitCount}(其中 SCC 环 ${stats.cyclicUnits} · 最大环 ${stats.largestCycle} 模块)`
  );
  if (stats.cyclicUnits > 0) {
    console.log('  提示:存在依赖环 → 环内模块须整体迁移;若为隐式边误合,可用声明依赖排序');
  }
  console.log('  自底向上前 8 个迁移单元(叶子优先):');
  for (const unit of result.order.units.slice(0, 8)) {
    const mark = unit.cyclic ? ' [SCC]' : '';
    console.log(`    ${String(unit.order).padStart(2)}. ${unit.label}${mark}`);
  }
  console.log(`  图指纹 ${hashMigrationGraph(graph).slice(0, 16)}`);
}

/** Rebuild the structural migration graph (M1→M2→M3-capabilities) from scratch. */
function rebuildStructuralGraph(
  root: string,
  reader: CodeSymbolGraph,
  packageName: string
): MigrationGraph {
  const graph = emptyMigrationGraph({
    platform: 'android',
    app: { name: path.basename(root), packageName },
  });
  const mod = buildModuleDependencyGraph(root, reader);
  if (mod.packageName) graph.source.app.packageName = mod.packageName;
  mergeInto(graph, { nodes: mod.nodes, edges: mod.edges, warnings: mod.warnings });

  const archModules = graph.nodes.filter((n) => n.kind === 'ArchModule');
  const comm = buildCommunityOverlay(archModules, reader);
  mergeInto(graph, { nodes: comm.nodes, edges: comm.edges, warnings: comm.warnings });

  const api = detectCapabilities(reader.getAllNodes(), nodeToModuleId(archModules, reader));
  mergeInto(graph, { nodes: api.capabilityNodes, edges: api.edges });
  const manifest = detectManifestCapabilities(root, moduleRefs(archModules));
  mergeInto(graph, {
    nodes: [...manifest.permissionNodes, ...manifest.capabilityNodes],
    edges: manifest.usesEdges,
    warnings: manifest.warnings,
  });

  // U · source-side semantic enrichment (roles / screens / entities / DI / flows / resources).
  const semantics = buildSemantics(reader, root, archModules, nodeToModuleId(archModules, reader));
  mergeInto(graph, { nodes: semantics.nodes, edges: semantics.edges, warnings: semantics.warnings });
  return graph;
}

async function cmdSync(pathArg: string, options: { out?: string }): Promise<void> {
  const root = path.resolve(pathArg);
  const outPath = options.out ? path.resolve(options.out) : migrationGraphPath(root);
  const before = readMigrationGraph(outPath);
  if (!before) {
    throw new Error(`未找到迁移图 ${outPath},请先运行完整流程后再 sync`);
  }

  // 1) Incrementally sync the base code-symbol index (only changed files re-parsed).
  if (CodeGraph.isInitialized(root)) {
    const cg = await CodeGraph.open(root, { sync: true });
    cg.close();
  }

  // 2) Rebuild the structural layer; preserve migration progress (order +
  //    target + the T3 publicInterface baselines `migrate plan` persisted —
  //    they are plan output, not structural facts, so the rebuild can't
  //    recompute them; stale baselines refresh on the next `migrate plan`).
  const reader = CodeSymbolGraph.open(root);
  try {
    const after = rebuildStructuralGraph(root, reader, before.source.app.packageName);
    after.order = before.order;
    const harmonyNodes = before.nodes.filter((n) => n.platform === 'harmony');
    const mapsTo = before.edges.filter((e) => e.kind === 'maps_to');
    mergeInto(after, { nodes: harmonyNodes, edges: mapsTo });

    const baselineById = new Map(
      before.nodes
        .filter((n) => n.kind === 'ArchModule' && Array.isArray(n.attrs?.publicInterface))
        .map((n) => [n.id, n.attrs!.publicInterface])
    );
    const withBaseline = after.nodes
      .filter((n) => n.kind === 'ArchModule' && baselineById.has(n.id))
      .map((n) => ({ ...n, attrs: { ...n.attrs, publicInterface: baselineById.get(n.id)! } }));
    mergeInto(after, { nodes: withBaseline });

    const diff = diffMigrationGraphs(before, after);
    writeMigrationGraph(outPath, after);
    const reportPath = path.join(path.dirname(outPath), 'sync-report.json');
    writeFileSync(reportPath, JSON.stringify(diff, null, 2) + '\n', 'utf8');

    printSyncDiff(diff, reportPath);
    console.log(`  图指纹 ${hashMigrationGraph(after).slice(0, 16)}`);
  } finally {
    reader.close();
  }
}

function printSyncDiff(diff: MigrationDiff, reportPath: string): void {
  console.log(`I1 增量同步 → ${path.relative(process.cwd(), reportPath)}`);
  if (diff.unchanged) {
    console.log('  源码无结构性变化 ✓(节点/边/模块均未变)');
    return;
  }
  console.log(
    `  节点 +${diff.nodesAdded.length}/-${diff.nodesRemoved.length}` +
      ` · 边 +${diff.edgesAdded}/-${diff.edgesRemoved}`
  );
  if (diff.capabilities.added.length || diff.capabilities.removed.length) {
    console.log(
      `  能力变化 +[${diff.capabilities.added.join(', ')}] -[${diff.capabilities.removed.join(', ')}]`
    );
  }
  if (diff.featuresChanged.length) {
    console.log(`  Feature 指纹变化 ${diff.featuresChanged.length} 个:${diff.featuresChanged.slice(0, 6).join(', ')}`);
  }
  const changed = diff.modules.filter((m) => m.change === 'changed');
  const added = diff.modules.filter((m) => m.change === 'added');
  const removed = diff.modules.filter((m) => m.change === 'removed');
  console.log(`  需重迁移的单元 ${diff.modules.length}(变更 ${changed.length} · 新增 ${added.length} · 删除 ${removed.length}):`);
  for (const m of diff.modules.slice(0, 10)) {
    const caps =
      m.capabilitiesAdded.length || m.capabilitiesRemoved.length
        ? ` 能力 +[${m.capabilitiesAdded.join(',')}] -[${m.capabilitiesRemoved.join(',')}]`
        : '';
    const sym =
      m.symbolCountBefore !== undefined && m.symbolCountBefore !== m.symbolCountAfter
        ? ` 符号 ${m.symbolCountBefore}→${m.symbolCountAfter}`
        : '';
    const sem = m.semanticsChanged ? ' [语义常量/契约变化]' : '';
    console.log(`    · [${m.change}] ${m.name}${sym}${caps}${sem}`);
  }
}

const LEDGER_STATUSES: LedgerStatus[] = ['pending', 'in-progress', 'migrated', 'verified', 'blocked'];

interface LedgerSetOptions {
  status?: string;
  targetModule?: string;
  targetPath?: string[];
  export?: string[];
  note?: string;
}

/** `migrate ledger set` — register a unit's migration status (agent-driven). */
function cmdLedgerSet(pathArg: string, unitQuery: string, options: LedgerSetOptions): void {
  const root = path.resolve(pathArg);
  const plan = readJsonFile<MigrationPlan>(path.join(getPlanDir(root), 'plan.json'));
  if (!plan) {
    throw new Error('未找到 plan.json,请先运行 “migrate plan” 再登记台账');
  }
  const unit = resolveUnit(plan, unitQuery);
  if (!unit) {
    throw new Error(`未找到迁移单元 “${unitQuery}”(可用 1 起序号 / id / 标签 / 模块名)`);
  }
  const status = options.status as LedgerStatus | undefined;
  if (!status || !LEDGER_STATUSES.includes(status)) {
    throw new Error(`--status 需为:${LEDGER_STATUSES.join(' / ')}`);
  }

  const ledgerPath = getLedgerPath(root);
  const ledger = readLedger(ledgerPath) ?? emptyLedger();
  const prev = ledger.units[unit.id] ?? null;
  assertTransition(prev?.status ?? null, status);

  const entry: LedgerEntry = { ...(prev ?? {}), status, updatedAt: new Date().toISOString() };
  if (options.targetModule !== undefined) entry.targetModule = options.targetModule;
  if (options.targetPath && options.targetPath.length > 0) {
    entry.targetPaths = [...new Set(options.targetPath.map((p) => p.split('\\').join('/')))].sort();
  }
  if (options.export && options.export.length > 0) entry.exportMap = parseExportMap(options.export);
  if (options.note !== undefined) entry.notes = options.note;
  ledger.units[unit.id] = entry;
  writeLedger(ledgerPath, ledger);

  console.log(`台账登记 ${unit.label} → ${status}${entry.targetModule ? ` @${entry.targetModule}` : ''}`);
  if (entry.targetPaths?.length) console.log(`  目标路径:${entry.targetPaths.join(', ')}`);
  if (entry.exportMap && Object.keys(entry.exportMap).length > 0) {
    console.log(`  导出改名:${Object.entries(entry.exportMap).map(([s, d]) => `${s}→${d}`).join(', ')}`);
  }
  console.log(`  → ${path.relative(process.cwd(), ledgerPath)}`);
}

/** `migrate ledger show` — the whole table, or one unit's detail. */
function cmdLedgerShow(pathArg: string, unitQuery?: string): void {
  const root = path.resolve(pathArg);
  const ledger = readLedger(getLedgerPath(root));
  if (!ledger) {
    console.log('台账为空(尚未运行 “migrate ledger set”)');
    return;
  }
  const plan = readJsonFile<MigrationPlan>(path.join(getPlanDir(root), 'plan.json'));

  if (unitQuery !== undefined) {
    const unit = plan ? resolveUnit(plan, unitQuery) : null;
    const unitId = unit?.id ?? unitQuery;
    const entry = ledger.units[unitId];
    if (!entry) {
      console.log(`单元 ${unitQuery}:pending(未登记)`);
      return;
    }
    console.log(`${unit?.label ?? unitId}: ${entry.status}`);
    if (entry.targetModule) console.log(`  目标模块:${entry.targetModule}`);
    if (entry.targetPaths?.length) console.log(`  目标路径:${entry.targetPaths.join(', ')}`);
    if (entry.exportMap && Object.keys(entry.exportMap).length > 0) {
      console.log(`  导出改名:${Object.entries(entry.exportMap).map(([s, d]) => `${s}→${d}`).join(', ')}`);
    }
    if (entry.notes) console.log(`  备注:${entry.notes}`);
    console.log(`  更新时间:${entry.updatedAt}`);
    return;
  }

  console.log('迁移台账:');
  if (plan) {
    for (const u of plan.units) {
      const e = ledger.units[u.id];
      const status = e ? e.status : 'pending(未登记)';
      const tgt = e?.targetModule ? ` → ${e.targetModule}` : '';
      console.log(`  ${String(u.order + 1).padStart(2)}. ${u.label}: ${status}${tgt}`);
    }
    const planIds = new Set(plan.units.map((u) => u.id));
    const orphans = Object.keys(ledger.units).filter((id) => !planIds.has(id));
    if (orphans.length > 0) {
      console.log(
        `  ⚠ orphan 台账条目 ${orphans.length} 个(重 pack 后单元 id 变化,未自动删除):${orphans.join(', ')}`
      );
    }
  } else {
    for (const [id, e] of Object.entries(ledger.units)) console.log(`  ${id}: ${e.status}`);
  }
}

/** `["Src=Dst", …]` → `{ Src: "Dst" }`. */
function parseExportMap(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const i = pair.indexOf('=');
    if (i <= 0) throw new Error(`--export 需 Src=Dst 形式,收到 “${pair}”`);
    out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

/** commander collector for repeatable options. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function printTopFeatures(result: ReturnType<typeof buildCommunityOverlay>): void {
  const top = [...result.communities].slice(0, 6);
  for (const c of top) {
    console.log(`    · ${c.hubName}  (${c.members.length} 文件, cohesion ${c.cohesion.toFixed(2)})`);
  }
}

function printTopModules(result: ReturnType<typeof buildModuleDependencyGraph>): void {
  const top = [...result.nodes]
    .sort((a, b) => Number(b.attrs?.symbolCount ?? 0) - Number(a.attrs?.symbolCount ?? 0))
    .slice(0, 5);
  for (const m of top) {
    console.log(`    · ${m.name}  (${m.attrs?.symbolCount ?? 0} 符号, ${m.subtype})`);
  }
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name('migrate')
    .description('Android 源工程结构分析:功能模块图谱 + 迁移工单 + 迁移验收(翻译由外部 agent 完成)')
    .version('0.1.0');

  program
    .command('index <path>')
    .description('建立/刷新源工程的 codegraph 代码符号索引')
    .action(async (pathArg: string) => {
      await cmdIndex(pathArg);
    });

  program
    .command('modules <path>')
    .description('M1 · 抽取 ArchModule + 模块间 depends_on(声明依赖 ∪ 隐式耦合)')
    .option('-o, --out <file>', '迁移图 JSON 输出路径(默认 <root>/.migration/migration-graph.json)')
    .action((pathArg: string, options: { out?: string }) => {
      cmdModules(pathArg, options);
    });

  program
    .command('community <path>')
    .description('M2 · 社区检测,把符号图确定性聚成 Feature 功能簇(精修模块划分)')
    .option('-o, --out <file>', '迁移图 JSON 路径(默认 <root>/.migration/migration-graph.json)')
    .action((pathArg: string, options: { out?: string }) => {
      cmdCommunity(pathArg, options);
    });

  program
    .command('capabilities <path>')
    .description('M3 · 从 import 识别框架/API 使用,给模块打 uses_capability + HarmonyOS 目标 API')
    .option('-o, --out <file>', '迁移图 JSON 路径(默认 <root>/.migration/migration-graph.json)')
    .action((pathArg: string, options: { out?: string }) => {
      cmdCapabilities(pathArg, options);
    });

  program
    .command('semantics <path>')
    .description('U · 源侧语义深化:角色/屏幕+导航/实体schema/DI图/数据流/资源(确定性 detect passes)')
    .option('-o, --out <file>', '迁移图 JSON 路径(默认 <root>/.migration/migration-graph.json)')
    .action((pathArg: string, options: { out?: string }) => {
      cmdSemantics(pathArg, options);
    });

  program
    .command('order <path>')
    .description('M3 · SCC 缩点 + 自底向上拓扑排序,给出模块迁移顺序(叶子优先)')
    .option('-o, --out <file>', '迁移图 JSON 路径(默认 <root>/.migration/migration-graph.json)')
    .option('--include-lifted', '把隐式耦合边也纳入排序(默认仅用声明依赖,避免误合成环)')
    .action((pathArg: string, options: { out?: string; includeLifted?: boolean }) => {
      cmdOrder(pathArg, options);
    });

  program
    .command('plan <path>')
    .description('P · 生成迁移工单:每个单元一份 brief(事实+锚点+验收清单)+ plan.json')
    .option('-o, --out <file>', '迁移图 JSON 路径(默认 <root>/.migration/migration-graph.json)')
    .option('--min-unit-symbols <n>', '小于该符号数的单元参与聚合(默认 120)')
    .option('--max-unit-symbols <n>', '大于该符号数的单模块单元按 Feature 细分拆分(默认 3000)')
    .option('--no-unit-planning', '关闭单元计划层,工单与模块 SCC 1:1')
    .action((pathArg: string, options: PlanCliOptions) => {
      cmdPlan(pathArg, options);
    });

  program
    .command('verify <path>')
    .description('M4 · 对外部 agent 迁移出的 HarmonyOS 工程做验收:能力/接口/屏幕/实体 diff')
    .requiredOption('-t, --target <dir>', '迁移产出的 HarmonyOS 工程根目录')
    .option('-o, --out <file>', '迁移图 JSON 路径')
    .option('--unit <unit>', '仅验收单个迁移单元(1 起序号 / id / 标签 / 模块名);按契约逐条核对并三分类缺口')
    .action(async (pathArg: string, options: { out?: string; target?: string; unit?: string }) => {
      await cmdVerify(pathArg, options);
    });

  program
    .command('sync <path>')
    .description('I1 · 增量同步:增量刷新底图 → 重算结构层 → 输出变更单元 diff 报告')
    .option('-o, --out <file>', '迁移图 JSON 路径')
    .action(async (pathArg: string, options: { out?: string }) => {
      await cmdSync(pathArg, options);
    });

  const ledger = program
    .command('ledger')
    .description('迁移台账:登记/查看每个单元的迁移状态(供 verify --unit 分类与作用域降级)');
  ledger
    .command('set <path> <unit>')
    .description('登记单元迁移状态(agent 迁移后调用,而非手改 JSON)')
    .requiredOption('--status <s>', `迁移状态:${LEDGER_STATUSES.join(' / ')}`)
    .option('--target-module <m>', '目标 HarmonyOS 模块名(如 entry)')
    .option('--target-path <p>', '目标工程根相对路径前缀(可多次;整体替换)', collect, [])
    .option(
      '--export <Src=Dst>',
      '源导出→目标导出改名(可多次;整体替换)。同名嵌套类型用限定名区分,如 FeedEvent.Action=FeedEventAction',
      collect,
      []
    )
    .option('--note <text>', '备注')
    .action((pathArg: string, unit: string, options: LedgerSetOptions) => {
      cmdLedgerSet(pathArg, unit, options);
    });
  ledger
    .command('show <path> [unit]')
    .description('查看台账全表(未登记单元标 pending)或单个单元明细')
    .action((pathArg: string, unit: string | undefined) => {
      cmdLedgerShow(pathArg, unit);
    });

  program
    .command('serve')
    .description('MCP 服务:把迁移图/工单/验收缺口暴露给外部迁移 agent 在线查询(stdio)')
    .option('--mcp', '以 MCP stdio 模式运行(当前唯一模式)')
    .option('-p, --path <root>', '源工程根目录(默认当前工作目录)')
    .action((options: { mcp?: boolean; path?: string }) => {
      if (!options.mcp) {
        throw new Error('serve 目前仅支持 MCP 模式:请加 --mcp');
      }
      new MigrateMcpServer(path.resolve(options.path ?? process.cwd())).start();
      // The stdio transport's stdin listener keeps the process alive.
    });

  return program;
}

async function main(): Promise<void> {
  try {
    await buildProgram().parseAsync(process.argv);
  } catch (err) {
    console.error(`错误:${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}

export { buildProgram };
