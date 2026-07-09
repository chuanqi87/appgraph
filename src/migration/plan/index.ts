/**
 * P · migration plan — turn the analyzed graph into the DELIVERABLE an external
 * migration agent consumes: one work-order (brief) per migration unit, in
 * bottom-up order, plus a machine-readable plan.json carrying the same facts.
 *
 * This is the hand-off boundary of appgraph: analysis ends here. The external
 * agent owns translation; it reads `plan.json` / `units/*.md`, migrates unit by
 * unit, and calls `migrate verify --target` as its acceptance gate.
 *
 * Deterministic: two runs over the same graph produce byte-identical output.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppNode, slug } from '../../appgraph/schema';
import { Node } from '../../types';
import { isLayoutHostingEdge } from '../../appgraph/detect/android-structure';
import { CodeSymbolGraph } from '../../appgraph/graph-reader';
import { getPlanDir } from '../paths';
import { canonicalJson } from '../../appgraph/serialize';
import { MigrationGraph } from '../types';
import {
  AssemblyInput,
  ImpliedDependency,
  ModuleBrief,
  assembleModuleBrief,
  extractPublicInterface,
} from './context';
import { renderUnitBrief } from './brief';
import { UnitContract, buildUnitContracts } from './contract';
import { APP_SCAFFOLD_UNIT_ID, buildAppScaffoldContract, renderAppScaffoldBrief } from './scaffold';
import {
  DEFAULT_PLANNING_OPTIONS,
  PlannedUnit,
  PlanningOptions,
  planUnits,
} from './unit-planning';

export const MIGRATION_PLAN_SCHEMA_VERSION = 4;

/** One migration unit with its member-module briefs and rendered work order. */
export interface UnitPlan {
  id: string;
  order: number;
  label: string;
  /** 'module' = one SCC unit · 'merged' = packed small units · 'split' = module slice. */
  kind: 'module' | 'merged' | 'split';
  cyclic: boolean;
  moduleIds: string[];
  /** split only: the subdivision Feature fingerprint ('rest' = remainder). */
  featureSig?: string;
  /** split only: the member files this sub-unit migrates. */
  files?: string[];
  symbolCount: number;
  /** 0-based parallel wave — deps sit in strictly earlier waves (schema ≥ 4). */
  wave: number;
  /** Ids of the units this unit directly depends on, sorted (schema ≥ 4). */
  dependsOnUnitIds: string[];
  /** Plan-dir-relative path of the rendered markdown brief. */
  briefFile: string;
  /** Plan-dir-relative path of the machine-readable acceptance contract. */
  contractFile: string;
  modules: ModuleBrief[];
}

export interface MigrationPlan {
  schemaVersion: number;
  source: MigrationGraph['source'];
  target: MigrationGraph['target'];
  /** The unit-planning knobs this plan was packed with (plan-time, not graph). */
  planning: {
    enabled: boolean;
    minUnitSymbols: number;
    maxUnitSymbols: number;
    merged: number;
    split: number;
  };
  totalUnits: number;
  units: UnitPlan[];
  /** Cross-unit global assembly work order (NOT a units[] entry). */
  appScaffold: { briefFile: string; contractFile: string };
}

export interface PlanResult {
  plan: MigrationPlan;
  /** android ArchModule id → its public member names (the T3 verify baseline). */
  publicInterfaceByModule: Map<string, string[]>;
  /** unit id → its acceptance contract (written as `contracts/NN-*.json`). */
  contracts: Map<string, UnitContract>;
}

/** Build the full migration plan from an ordered, semantics-enriched graph. */
export function buildMigrationPlan(
  graph: MigrationGraph,
  reader: CodeSymbolGraph,
  options: Partial<PlanningOptions> = {}
): PlanResult {
  if (!graph.order) throw new Error('迁移图缺少迁移顺序,请先运行 “migrate order”');
  const opts: PlanningOptions = { ...DEFAULT_PLANNING_OPTIONS, ...options };

  const input = buildAssemblyInput(graph, reader);
  const { filesByModuleId, fileSymbolCounts } = moduleFileIndex(input);
  const planned = planUnits(graph.order, graph, opts, filesByModuleId, fileSymbolCounts);
  const pad = Math.max(2, String(planned.units.length).length);

  // T3 baseline: ALWAYS the whole module's public surface, independent of how
  // units are packed — a planned unit is a work envelope, not a verify identity.
  const publicInterfaceByModule = new Map<string, string[]>();
  const baseline = (moduleId: string): void => {
    if (publicInterfaceByModule.has(moduleId)) return;
    const nodes = (input.moduleIdToNodeIds.get(moduleId) ?? [])
      .map((id) => input.nodeById.get(id))
      .filter((n): n is Node => n !== undefined);
    publicInterfaceByModule.set(
      moduleId,
      [...new Set(extractPublicInterface(nodes).map((x) => x.name))].sort()
    );
  };

  const unitPlans: UnitPlan[] = [];
  for (const unit of planned.units) {
    const fileFilter = unit.files ? new Set(unit.files) : undefined;
    const modules = [...unit.moduleIds]
      .sort()
      .map((id) => assembleModuleBrief(id, input, fileFilter));
    unit.moduleIds.forEach(baseline);
    const base = unitFileBase(unit, pad);
    unitPlans.push({
      id: unit.id,
      order: unit.order,
      label: unit.label,
      kind: unit.kind,
      cyclic: unit.cyclic,
      moduleIds: [...unit.moduleIds].sort(),
      featureSig: unit.featureSig,
      files: unit.files,
      symbolCount: unit.symbolCount,
      wave: unit.wave,
      dependsOnUnitIds: unit.dependsOnUnitIds,
      briefFile: `units/${base}.md`,
      contractFile: `contracts/${base}.json`,
      modules,
    });
  }

  // Acceptance contracts — generated from whole-module facts, assigned to units.
  const contracts = buildUnitContracts(unitPlans, input);

  const plan: MigrationPlan = {
    schemaVersion: MIGRATION_PLAN_SCHEMA_VERSION,
    source: graph.source,
    target: graph.target,
    planning: {
      enabled: opts.enabled,
      minUnitSymbols: opts.minUnitSymbols,
      maxUnitSymbols: opts.maxUnitSymbols,
      merged: planned.stats.merged,
      split: planned.stats.split,
    },
    totalUnits: unitPlans.length,
    units: unitPlans,
    appScaffold: {
      briefFile: 'units/00-app-scaffold.md',
      contractFile: 'contracts/00-app-scaffold.json',
    },
  };
  // App-scaffold: cross-unit global assembly (route table + module.json5 gates).
  contracts.set(APP_SCAFFOLD_UNIT_ID, buildAppScaffoldContract(plan));

  return { plan, publicInterfaceByModule, contracts };
}

/** Per-module file lists + per-file symbol counts (split sizing inputs). */
function moduleFileIndex(input: AssemblyInput): {
  filesByModuleId: Map<string, string[]>;
  fileSymbolCounts: Map<string, number>;
} {
  const filesByModuleId = new Map<string, string[]>();
  const fileSymbolCounts = new Map<string, number>();
  for (const [moduleId, nodeIds] of input.moduleIdToNodeIds) {
    const files = new Set<string>();
    for (const id of nodeIds) {
      const node = input.nodeById.get(id);
      if (!node) continue;
      files.add(node.filePath);
      fileSymbolCounts.set(node.filePath, (fileSymbolCounts.get(node.filePath) ?? 0) + 1);
    }
    filesByModuleId.set(moduleId, [...files].sort());
  }
  return { filesByModuleId, fileSymbolCounts };
}

/**
 * Write plan.json + one markdown brief + one JSON contract per unit under
 * `.migration/plan/`. The dir is a fully generated artifact — rebuilt from
 * scratch so a stale unit layout can't linger.
 */
export function writeMigrationPlan(
  projectRoot: string,
  plan: MigrationPlan,
  contracts: Map<string, UnitContract>
): string {
  const planDir = getPlanDir(projectRoot);
  rmSync(planDir, { recursive: true, force: true });
  mkdirSync(join(planDir, 'units'), { recursive: true });
  mkdirSync(join(planDir, 'contracts'), { recursive: true });

  writeFileSync(join(planDir, 'plan.json'), canonicalJson(plan) + '\n', 'utf8');
  const unitRefById = new Map(plan.units.map((u) => [u.id, `${u.order + 1}. ${u.label}`]));
  for (const unit of plan.units) {
    const contract = contracts.get(unit.id);
    const md = renderUnitBrief(unit, unit.modules, plan.totalUnits, contract, unitRefById);
    writeFileSync(join(planDir, unit.briefFile), md + '\n', 'utf8');
    if (contract) {
      writeFileSync(join(planDir, unit.contractFile), canonicalJson(contract) + '\n', 'utf8');
    }
  }

  // App-scaffold work order + its app-level contract (sorts before unit 01).
  writeFileSync(join(planDir, plan.appScaffold.briefFile), renderAppScaffoldBrief(plan) + '\n', 'utf8');
  const scaffoldContract = contracts.get(APP_SCAFFOLD_UNIT_ID);
  if (scaffoldContract) {
    writeFileSync(join(planDir, plan.appScaffold.contractFile), canonicalJson(scaffoldContract) + '\n', 'utf8');
  }
  return planDir;
}

/** `03-corecommon` — order-sortable, filesystem-friendly base for brief+contract. */
function unitFileBase(unit: Pick<PlannedUnit, 'label' | 'order'>, pad: number): string {
  const label =
    unit.label
      .split(',')
      .map((name) => slug(name))
      .filter(Boolean)
      .join('+')
      .slice(0, 60) || 'unit';
  return `${String(unit.order + 1).padStart(pad, '0')}-${label}`;
}

/**
 * Build the shared assembly input: module maps, symbol assignment, declared +
 * lifted dependencies, per-module semantic ownership (screens/models/permission
 * capabilities) and the screen navigation fan-out.
 */
export function buildAssemblyInput(graph: MigrationGraph, reader: CodeSymbolGraph): AssemblyInput {
  const moduleById = new Map<string, AppNode>();
  const moduleDirToId = new Map<string, string>();
  const moduleDirs: string[] = [];
  for (const n of graph.nodes) {
    if (n.kind !== 'ArchModule' || n.platform !== 'android') continue;
    moduleById.set(n.id, n);
    const dir = typeof n.attrs?.dir === 'string' ? n.attrs.dir : undefined;
    if (dir !== undefined) {
      moduleDirToId.set(dir, n.id);
      moduleDirs.push(dir);
    }
  }

  const nodes = reader.getAllNodes();
  const nodeById = new Map<string, Node>(nodes.map((n) => [n.id, n]));
  const moduleIdToNodeIds = assignNodeIdsByModule(nodes, moduleDirs, moduleDirToId);

  // Declared depends_on is the ground truth; lifted coupling is advisory.
  // Test-scoped declared deps (testImplementation/…) are kept apart: they are
  // not migration prerequisites and must not read as blocking in a brief.
  const moduleDeps = new Map<string, string[]>();
  const moduleTestDeps = new Map<string, string[]>();
  const liftedDeps = new Map<string, ImpliedDependency[]>();
  for (const e of graph.edges) {
    if (e.kind !== 'depends_on') continue;
    if (!moduleById.has(e.from) || !moduleById.has(e.to)) continue;
    if (e.provenance === 'manifest') {
      const bucket = e.attrs?.scope === 'test' ? moduleTestDeps : moduleDeps;
      const list = bucket.get(e.from) ?? [];
      list.push(e.to);
      bucket.set(e.from, list);
    } else {
      // A reverse-of-declared lifted edge is resolver noise (e.g. a feature
      // "depending on" :app) — do not present it to the migration agent.
      if (e.attrs?.suspect === 'reverse-of-declared') continue;
      const list = liftedDeps.get(e.from) ?? [];
      list.push({
        moduleName: moduleById.get(e.to)?.name ?? e.to,
        weight: typeof e.attrs?.weight === 'number' ? e.attrs.weight : 0,
        byKind: asByKind(e.attrs?.byKind),
      });
      liftedDeps.set(e.from, list);
    }
  }
  for (const [k, v] of liftedDeps) {
    liftedDeps.set(
      k,
      v.sort((a, b) => b.weight - a.weight || a.moduleName.localeCompare(b.moduleName))
    );
  }

  // Screen → hosted xml-layout links (S2 set-content-view). A hosted layout is
  // its host screen's implementation detail — it renders as `layouts` on the
  // host, not as a standalone screen of the module.
  const nodeByAppId = new Map(graph.nodes.map((n) => [n.id, n]));
  const layoutsByScreenId = new Map<string, string[]>();
  const hostedLayoutIds = new Set<string>();
  for (const e of graph.edges) {
    if (!isLayoutHostingEdge(e)) continue;
    const layout = nodeByAppId.get(e.to);
    if (!layout || layout.kind !== 'Screen') continue;
    hostedLayoutIds.add(layout.id);
    const list = layoutsByScreenId.get(e.from) ?? [];
    if (!list.includes(layout.name)) list.push(layout.name);
    layoutsByScreenId.set(e.from, list);
  }
  for (const [k, v] of layoutsByScreenId) layoutsByScreenId.set(k, v.sort());

  // Per-module semantic ownership, read off the U/S2-enriched graph.
  const screensByModule = new Map<string, AppNode[]>();
  const dataModelsByModule = new Map<string, AppNode[]>();
  const backgroundByModule = new Map<string, AppNode[]>();
  const appEntriesByModule = new Map<string, string[]>();
  const owningModuleByNodeId = new Map<string, string>();
  for (const e of graph.edges) {
    if (e.kind !== 'app_contains' || !moduleById.has(e.from)) continue;
    const target = nodeByAppId.get(e.to);
    if (!target || target.platform !== 'android') continue;
    owningModuleByNodeId.set(target.id, e.from);
    if (target.kind === 'Screen') {
      if (!hostedLayoutIds.has(target.id)) pushTo(screensByModule, e.from, target);
    } else if (target.kind === 'DataModel') {
      pushTo(dataModelsByModule, e.from, target);
    } else if (target.kind === 'BackgroundComponent') {
      pushTo(backgroundByModule, e.from, target);
    } else if (target.kind === 'AppEntry') {
      const list = appEntriesByModule.get(e.from) ?? [];
      if (!list.includes(target.name)) list.push(target.name);
      appEntriesByModule.set(e.from, list);
    }
  }
  for (const [k, v] of appEntriesByModule) appEntriesByModule.set(k, v.sort());

  // Deep links (S2 exposes edges), attributed via the exposing screen/component.
  const deeplinksByModule = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.kind !== 'exposes') continue;
    const resource = nodeByAppId.get(e.to);
    if (!resource || resource.kind !== 'Resource') continue;
    const moduleId = owningModuleByNodeId.get(e.from);
    if (!moduleId) continue;
    const list = deeplinksByModule.get(moduleId) ?? [];
    if (!list.includes(resource.name)) list.push(resource.name);
    deeplinksByModule.set(moduleId, list);
  }
  for (const [k, v] of deeplinksByModule) deeplinksByModule.set(k, v.sort());

  // Screen navigation fan-out (U2 + S2 navigates_to edges), by screen node id.
  const navTargetsByScreenId = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.kind !== 'navigates_to') continue;
    const to = nodeByAppId.get(e.to);
    if (!to || to.kind !== 'Screen') continue;
    const list = navTargetsByScreenId.get(e.from) ?? [];
    if (!list.includes(to.name)) list.push(to.name);
    navTargetsByScreenId.set(e.from, list);
  }
  for (const [k, v] of navTargetsByScreenId) navTargetsByScreenId.set(k, v.sort());

  const permissionCapsByModule = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.kind !== 'uses_capability' || e.provenance !== 'manifest') continue;
    const cap = nodeByAppId.get(e.to);
    if (!cap || cap.kind !== 'Capability') continue;
    const id = cap.matchKey.includes(':') ? cap.matchKey.slice(cap.matchKey.indexOf(':') + 1) : cap.matchKey;
    const list = permissionCapsByModule.get(e.from) ?? [];
    if (!list.includes(id)) list.push(id);
    permissionCapsByModule.set(e.from, list);
  }
  for (const [k, v] of permissionCapsByModule) permissionCapsByModule.set(k, v.sort());

  return {
    moduleById,
    moduleIdToNodeIds,
    nodeById,
    moduleDeps,
    moduleTestDeps,
    liftedDeps,
    screensByModule,
    dataModelsByModule,
    navTargetsByScreenId,
    permissionCapsByModule,
    backgroundByModule,
    appEntriesByModule,
    deeplinksByModule,
    layoutsByScreenId,
  };
}

function asByKind(v: unknown): Record<string, number> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, number>) : {};
}

/** Append a node to a module's list in a Map-of-arrays. */
function pushTo(map: Map<string, AppNode[]>, key: string, node: AppNode): void {
  const list = map.get(key) ?? [];
  list.push(node);
  map.set(key, list);
}

/** module id → code node ids, via longest module-dir prefix of each node's path. */
function assignNodeIdsByModule(
  nodes: Node[],
  moduleDirs: string[],
  moduleDirToId: Map<string, string>
): Map<string, string[]> {
  const dirsByLength = [...new Set(moduleDirs)].filter(Boolean).sort((a, b) => b.length - a.length);
  const fileToDir = new Map<string, string | null>();
  const out = new Map<string, string[]>();
  for (const node of nodes) {
    let dir = fileToDir.get(node.filePath);
    if (dir === undefined) {
      dir = dirsByLength.find((d) => node.filePath === d || node.filePath.startsWith(`${d}/`)) ?? null;
      fileToDir.set(node.filePath, dir);
    }
    if (dir === null) continue;
    const moduleId = moduleDirToId.get(dir);
    if (!moduleId) continue;
    const list = out.get(moduleId) ?? [];
    list.push(node.id);
    out.set(moduleId, list);
  }
  return out;
}
