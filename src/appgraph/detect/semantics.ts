/**
 * U · source-side semantic enrichment — orchestration.
 *
 * Runs the six deterministic detect passes over the already-built structural
 * graph and returns the semantic augmentation: role-tagged ArchModules, Compose
 * + XML-View Screen nodes with a navigation graph, DataModels with field
 * schemas, the DI object graph, and resources. Every span is read from disk at
 * most once (memoized `readCode`) and shared across passes.
 *
 * Output merges cleanly via `mergeInto`: ArchModule nodes are RE-EMITTED with
 * enriched attrs (roleCounts / di / flows) so the merge overwrites them in
 * place, and all new nodes/edges carry content-derived ids so two runs over
 * unchanged source stay byte-identical.
 */

import { AppEdge, AppNode, CoverageWarning } from '../schema';
import { Node } from '../../types';
import { CodeSymbolGraph } from '../graph-reader';
import { ModuleRef } from './manifest-capabilities';
import { detectAndroidStructure } from './android-structure';
import { detectNavigationXml } from './android-navigation-xml';
import { detectNavFrameworks } from './nav-frameworks';
import { detectComposeScreens } from './compose';
import { detectConstants, ConstantsFacts } from './constants';
import { detectDi, DiFacts } from './di';
import { detectEntities } from './entities';
import { detectFlows, FlowFacts } from './flows';
import { aggregateRolesByModule, detectRoles, RoleResult } from './roles';
import { detectResources } from './resources';
import { detectTestContract, TestContractFacts } from './tests';
import { DetectContext, ReadCode } from './shared';
import { liftNavigatesToFromCore } from '../lift/navigates-from-core';

export interface SemanticsResult {
  nodes: AppNode[];
  edges: AppEdge[];
  warnings: CoverageWarning[];
  /** Third-party navigation/UI framework names fingerprinted (S4) — declared
   *  blind spots the caller records at graph top level. */
  navFrameworks: string[];
  /** Role map (by qualifiedName) for the migrate/context assembler (C1). */
  roles: RoleResult;
  stats: {
    rolesTagged: number;
    screens: number;
    navEdges: number;
    dataModels: number;
    diModules: number;
    diWiredEdges: number;
    exposedStates: number;
    resourceFiles: number;
    layoutScreens: number;
    /** S2 · manifest components + intent navigation + layout hosting. */
    activityScreens: number;
    backgroundComponents: number;
    appEntries: number;
    deeplinks: number;
    intentNavEdges: number;
    backedByEdges: number;
    layoutLinks: number;
    /** S3 · declared nav-graph XML navigation (conf 1). */
    navGraphXmlEdges: number;
    navGraphXmlScreens: number;
    /** S4 · third-party nav frameworks fingerprinted (each is a declared blind spot). */
    navFrameworks: number;
    /** U7 · semantic constants (L3 migration-invariant literals). */
    constantLiterals: number;
    constantRoutes: number;
    constantQueries: number;
    constantEnums: number;
    /** E · test-porting contract (L4-lite). */
    testClasses: number;
    testCases: number;
    warnings: number;
  };
}

/**
 * Build the semantic augmentation. `nodeToModuleId` maps each code-symbol node
 * to its owning ArchModule (the M1 assignment); `archModules` are the persisted
 * ArchModule nodes to enrich.
 */
export function buildSemantics(
  reader: CodeSymbolGraph,
  root: string,
  archModules: AppNode[],
  nodeToModuleId: Map<string, string>
): SemanticsResult {
  const nodes = reader.getAllNodes();
  const readCode = memoizeCode(reader);
  const ctx: DetectContext = {
    nodeToModuleId,
    moduleNameById: new Map(archModules.map((m) => [m.id, m.name])),
    archModules,
  };

  // U1 roles.
  const roles = detectRoles(nodes, readCode);
  const roleCounts = aggregateRolesByModule(roles.byNodeId, nodeToModuleId);

  // U2 compose screens + navigation.
  const compose = detectComposeScreens(nodes, readCode, ctx);
  // U3 entities + field schema.
  const entities = detectEntities(nodes, readCode, ctx);
  // U4 DI object graph.
  const di = detectDi(nodes, readCode, ctx);
  // U5 reactive flows.
  const flows = detectFlows(nodes, readCode, ctx);
  // U7 semantic constants (L3 migration-invariant literals).
  const constants = detectConstants(nodes, readCode, ctx);
  // E test-porting contract (L4-lite) — the ONLY pass over the test source set.
  const tests = detectTestContract(nodes, readCode, ctx);
  // U6 resources + XML-View layouts (file-driven).
  const resources = detectResources(root, moduleRefs(archModules));
  // S2 · Android structure: manifest components + convention-discovered Fragment
  // screens + layout hosting (navigation EDGES are lifted from the core graph below).
  const structure = detectAndroidStructure(
    root,
    moduleRefs(archModules),
    new Set(resources.layoutScreenNodes.map((n) => n.id))
  );

  // S3 · declared nav-graph XML navigation (Jetpack Navigation). Runs over the
  // Screen index the passes above built so destinations reuse existing nodes;
  // its edges are manifest-grade (conf 1) — the richest source in Fragment apps.
  const navXml = detectNavigationXml(root, moduleRefs(archModules), [
    ...compose.screenNodes,
    ...resources.layoutScreenNodes,
    ...structure.nodes.filter((n) => n.kind === 'Screen'),
  ]);

  // Navigation lift FROM the core graph: Screen→Screen navigates_to (compose-route)
  // and Screen→Screen / Screen→BackgroundComponent (android-intent), over every
  // Screen + BackgroundComponent the passes above produced. Single deterministic
  // derivation — replaces the compose + intent source scans.
  const navTargets: AppNode[] = [
    ...compose.screenNodes,
    ...resources.layoutScreenNodes,
    ...structure.nodes.filter((n) => n.kind === 'Screen' || n.kind === 'BackgroundComponent'),
    ...navXml.screenNodes,
  ];
  const navLift = liftNavigatesToFromCore(reader, navTargets);

  // S4 · third-party navigation frameworks: fingerprint → explicit blind-spot
  // warning (an under-detected screen/nav graph must never read as complete).
  const navFrameworks = detectNavFrameworks(nodes);

  const screenCount = navTargets.filter((n) => n.kind === 'Screen').length;
  const totalNavEdges = navLift.stats.navigatesTo + navXml.stats.navEdges;
  const navWarnings = navCoverageWarnings(
    {
      screenCount,
      totalNavEdges,
      activityScreens: structure.stats.activityScreens,
      appEntries: structure.stats.appEntries,
    },
    () => reader.getSynthesizedEdges(['compose-route', 'android-intent']).length
  );

  const enrichedModules = archModules.map((m) =>
    enrichModule(m, {
      roleCounts: roleCounts.get(m.id),
      di: di.diByModule.get(m.id),
      flows: flows.flowsByModule.get(m.id),
      constants: constants.constantsByModule.get(m.id),
      testContract: tests.testContractByModule.get(m.id),
    })
  );

  const outNodes: AppNode[] = [
    ...enrichedModules,
    ...compose.screenNodes,
    ...entities.dataModelNodes,
    ...resources.resourceNodes,
    ...resources.layoutScreenNodes,
    ...structure.nodes,
    ...navXml.screenNodes,
  ];
  const outEdges: AppEdge[] = [
    // nav_graph.xml edges (manifest, conf 1) FIRST so they win the first-write
    // dedup over a same-id programmatic android-fragment edge (lifted, conf 0.8).
    ...navXml.edges,
    ...navLift.navEdges,
    ...compose.containsEdges,
    ...entities.containsEdges,
    ...di.diEdges,
    ...resources.containsEdges,
    ...structure.edges,
  ];
  const warnings: CoverageWarning[] = [
    ...compose.warnings,
    ...entities.warnings,
    ...di.warnings,
    ...flows.warnings,
    ...constants.warnings,
    ...resources.warnings,
    ...structure.warnings,
    ...navXml.warnings,
    ...navFrameworks.warnings,
    ...navWarnings,
  ];

  return {
    nodes: outNodes,
    edges: outEdges,
    warnings,
    navFrameworks: navFrameworks.frameworks,
    roles,
    stats: {
      rolesTagged: roles.byNodeId.size,
      screens: compose.stats.screenCount,
      navEdges: navLift.stats.navigatesTo,
      dataModels: entities.dataModelNodes.length,
      diModules: di.stats.moduleCount,
      diWiredEdges: di.stats.wiredEdges,
      exposedStates: flows.stats.exposedStates,
      resourceFiles: resources.stats.valueFiles,
      layoutScreens: resources.stats.layoutFiles,
      activityScreens: structure.stats.activityScreens,
      backgroundComponents: structure.stats.backgroundComponents,
      appEntries: structure.stats.appEntries,
      deeplinks: structure.stats.deeplinks,
      intentNavEdges: structure.stats.intentNavEdges,
      backedByEdges: navLift.stats.backedBy,
      layoutLinks: structure.stats.layoutLinks,
      navGraphXmlEdges: navXml.stats.navEdges,
      navGraphXmlScreens: navXml.stats.newScreens,
      navFrameworks: navFrameworks.frameworks.length,
      constantLiterals: constants.stats.literals,
      constantRoutes: constants.stats.routes,
      constantQueries: constants.stats.queries,
      constantEnums: constants.stats.enums,
      testClasses: tests.stats.testClasses,
      testCases: tests.stats.totalTests,
      warnings: warnings.length,
    },
  };
}

/**
 * Nav-coverage anti-silence guards (P0-3). Pure over the counts so it is unit-
 * testable; the caller supplies `getSynthCount` lazily (only the empty-nav
 * branch reads it). An empty/sparse navigation graph — or manifest Activities
 * with no richer screen recovered at all — is a coverage FAILURE the agent must
 * SEE, never a plausible-looking "no navigation".
 *
 * (The empty-nav regression that motivated the first guard: a `.codegraph`
 * indexed by a pre-synthesizer build has zero compose-route/android-intent
 * edges, and the lift silently produced navigates_to=0 while everything else
 * looked healthy. The Screen under-detection guard treats CatchUp's
 * 3-screens-0-warnings gap: S4's fingerprint catches the known-framework case,
 * this catches the framework-unknown case.)
 */
export function navCoverageWarnings(
  counts: { screenCount: number; totalNavEdges: number; activityScreens: number; appEntries: number },
  getSynthCount: () => number
): CoverageWarning[] {
  const { screenCount, totalNavEdges, activityScreens, appEntries } = counts;
  const out: CoverageWarning[] = [];

  if (screenCount >= 5 && totalNavEdges === 0) {
    const synthCount = getSynthCount();
    out.push({
      message:
        synthCount === 0
          ? `识别出 ${screenCount} 个 Screen，但核心图中没有任何 compose-route/android-intent 合成边——` +
            `导航图为空，不可依赖。若 .codegraph 索引由旧版本构建，请用当前版本重跑 codegraph index；` +
            `若索引已是最新，则该应用的导航机制（如 Fragment 事务/自研路由）未被合成器覆盖`
          : `识别出 ${screenCount} 个 Screen、核心图有 ${synthCount} 条导航合成边，但没有一条能归因到 Screen——` +
            `导航图为空，页面迁移关系不可依赖`,
    });
  } else if (screenCount >= 20 && totalNavEdges < screenCount * 0.05) {
    out.push({
      message:
        `识别出 ${screenCount} 个 Screen 但只有 ${totalNavEdges} 条 navigates_to——` +
        `导航覆盖异常稀疏（该应用的导航机制可能未被合成器覆盖，页面迁移关系不完整）`,
    });
  }

  // Screen under-detection: a SINGLE-Activity app (one manifest Activity host)
  // with launcher entries but NO richer screen (Compose / xml-layout / Fragment)
  // recovered at all — modern single-Activity apps are Compose-nav or
  // Fragment-nav, so finding neither means the real screens are built by a
  // mechanism the passes don't see. Gated on activityScreens===1 on purpose: a
  // multi-Activity View app (each Activity IS a screen) is legitimately complete
  // even with richScreens===0, so it must NOT warn ("silent beats wrong").
  const richScreens = screenCount - activityScreens;
  if (appEntries > 0 && activityScreens === 1 && richScreens === 0) {
    out.push({
      message:
        `工程是单 Activity 结构（1 个宿主 Activity、${appEntries} 个启动入口），` +
        `但除该 Activity 外未识别出任何 Compose/布局/Fragment 屏幕——` +
        `UI 屏幕很可能经未覆盖的机制（第三方路由/自研框架）构建，屏幕清单不完整，勿当作完整事实`,
    });
  }
  return out;
}

/** The per-module semantic facts the orchestrator folds into an ArchModule's attrs. */
interface ModuleSemantics {
  roleCounts?: Record<string, number>;
  di?: DiFacts;
  flows?: FlowFacts;
  constants?: ConstantsFacts;
  testContract?: TestContractFacts;
}

/** Re-emit an ArchModule with semantic attrs merged in (preserves existing attrs). */
function enrichModule(module: AppNode, s: ModuleSemantics): AppNode {
  const attrs: Record<string, unknown> = { ...module.attrs };
  if (s.roleCounts && Object.keys(s.roleCounts).length > 0) attrs.roleCounts = s.roleCounts;
  if (s.di && (s.di.modules.length || s.di.provides.length || s.di.binds.length || s.di.injectionPoints.length)) {
    attrs.di = s.di;
  }
  if (s.flows && (s.flows.exposedStates.length || s.flows.collectPoints > 0)) attrs.flows = s.flows;
  if (
    s.constants &&
    (s.constants.literals.length ||
      s.constants.routes.length ||
      s.constants.queries.length ||
      s.constants.enums.length)
  ) {
    attrs.constants = s.constants;
  }
  if (s.testContract && s.testContract.classes.length > 0) attrs.testContract = s.testContract;
  return { ...module, attrs };
}

/** ArchModule nodes → the {id,name,dir} refs the resource attributor needs. */
function moduleRefs(archModules: AppNode[]): ModuleRef[] {
  const refs: ModuleRef[] = [];
  for (const m of archModules) {
    const dir = typeof m.attrs?.dir === 'string' ? m.attrs.dir : undefined;
    if (dir !== undefined) refs.push({ id: m.id, name: m.name, dir });
  }
  return refs;
}

/** Wrap the reader in a per-node source cache so each span is read at most once. */
function memoizeCode(reader: CodeSymbolGraph): ReadCode {
  const cache = new Map<string, string | null>();
  return (node: Node): string | null => {
    const cached = cache.get(node.id);
    if (cached !== undefined) return cached;
    const code = reader.getCode(node);
    cache.set(node.id, code);
    return code;
  };
}
