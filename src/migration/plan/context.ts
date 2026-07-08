/**
 * P · module brief assembly — deterministically gather the ANALYSIS facts an
 * external migration agent needs about ONE source module:
 *   - the module's public interface (the surface other modules depend on, with
 *     file anchors so the agent can jump to the real source),
 *   - the capabilities it uses + their HarmonyOS target APIs (translation
 *     anchors — mapping DATA, not translation instructions),
 *   - its screens (with navigation targets), data models (field schemas), DI
 *     assembly, reactive flows and permission capabilities (the U-pass facts,
 *     read off the enriched graph), and
 *   - its declared dependencies (build-file ground truth) plus the implicit
 *     coupling lifted from the code graph (advisory, weighted).
 *
 * Pure assembly — no LLM, no translation state. appgraph's job ends at
 * analysis; translating and assembling the target project is owned by an
 * external migration agent that consumes these briefs.
 */

import { AppNode } from '../../appgraph/schema';
import { Node, NodeKind } from '../../types';
import { HarmonyTarget, apiToCapability, harmonyTargetFor } from '../capabilities-ext';
import { ConstantsFacts } from '../../appgraph/detect/constants';
import { DiFacts } from '../../appgraph/detect/di';
import { FlowFacts } from '../../appgraph/detect/flows';
import { FieldSchema } from '../../appgraph/detect/entities';
import { TestContractFacts } from '../../appgraph/detect/tests';

/** Public interface kinds — the cross-module surface (types + top-level fns). */
const INTERFACE_KINDS = new Set<NodeKind>(['class', 'interface', 'enum', 'function']);
const TEST_PATH_RE = /\/src\/(test|androidTest|androidtest)\//i;

export interface InterfaceMember {
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  visibility?: string;
  signature?: string;
  file: string;
}

export interface CapabilityUse {
  id: string;
  harmony: HarmonyTarget | null;
  evidence: string[];
}

/** A declared (build-file) dependency — ground truth, confidence 1. */
export interface DependencyBrief {
  moduleName: string;
  /** The dependency's public member names (its source-side surface). */
  publicMembers: string[];
}

/** Implicit coupling lifted from the code graph — advisory, evidence-weighted. */
export interface ImpliedDependency {
  moduleName: string;
  /** Number of cross-module code edges backing this coupling. */
  weight: number;
  /** Per-edge-kind breakdown (calls/references/…), for auditing. */
  byKind: Record<string, number>;
}

/** A screen this module owns (U2/U6/S2), with its navigation fan-out. */
export interface ScreenBrief {
  name: string;
  /** Source file anchor (project-relative). */
  file?: string;
  /** 'compose' | 'xml-layout' | 'activity' | 'fragment' — which system produced it. */
  subtype?: string;
  /** Names of screens this one navigates to (U2 + S2 navigates_to edges). */
  navigatesTo: string[];
  /** xml-layout screens this one hosts (S2 setContentView/inflate links). */
  layouts: string[];
}

/** A background component this module declares (S2, manifest ground truth). */
export interface BackgroundComponentBrief {
  name: string;
  /** 'service' | 'receiver' | 'provider'. */
  subtype: string;
  exported?: boolean;
  foregroundServiceType?: string;
  /** HarmonyOS translation target (harmonyComponentTargetFor). */
  harmonyModule?: string;
  harmonyNote?: string;
  /** Manifest file anchor (project-relative). */
  file?: string;
}

/** A source data model (U3) — drives target RDB table / interface design. */
export interface DataModelBrief {
  name: string;
  subtype: string;
  tableName?: string;
  /** Source file anchor (project-relative). */
  file?: string;
  fields: FieldSchema[];
}

/** Everything the analysis knows about one source module — the brief's data. */
export interface ModuleBrief {
  moduleId: string;
  moduleName: string;
  role?: string;
  layer?: string;
  /** Code symbols assigned to this module (size signal for unit planning). */
  symbolCount?: number;
  publicInterface: InterfaceMember[];
  capabilities: CapabilityUse[];
  dependencies: DependencyBrief[];
  impliedDependencies: ImpliedDependency[];
  /** Component-role distribution across this module's symbols (U1). */
  roleCounts?: Record<string, number>;
  /** Screens this module owns (U2/U6/S2) — target pages + router config. */
  screens: ScreenBrief[];
  /** Data models this module owns (U3) — target RDB tables / interfaces. */
  dataModels: DataModelBrief[];
  /** DI assembly this module declares (U4) — manual wiring on the target. */
  di?: DiFacts;
  /** Reactive states this module exposes/collects (U5). */
  flows?: FlowFacts;
  /** Migration-invariant literals this module declares (U7) — L3 acceptance truth. */
  constants?: ConstantsFacts;
  /** Test-porting obligations this module carries (E) — L4-lite checklist. */
  testContract?: TestContractFacts;
  /** Permission-backed capability ids this module declares (S1). */
  permissionCapabilities: string[];
  /** Background components this module declares (S2) — target Abilities/订阅. */
  backgroundComponents: BackgroundComponentBrief[];
  /** Launcher-entry screen names (S2 AppEntry) — target EntryAbility 入口. */
  appEntries: string[];
  /** Deep links this module exposes (S2 Resource) — target module.json5 skills. */
  deeplinks: string[];
}

export interface AssemblyInput {
  moduleById: Map<string, AppNode>;
  /** module id → its code node ids. */
  moduleIdToNodeIds: Map<string, string[]>;
  nodeById: Map<string, Node>;
  /** declared module→module depends_on (from → set of to). */
  moduleDeps: Map<string, string[]>;
  /** lifted module→module coupling (from → advisory dependencies). */
  liftedDeps: Map<string, ImpliedDependency[]>;
  /** module id → owned Screen nodes (U2/U6), via app_contains. */
  screensByModule: Map<string, AppNode[]>;
  /** module id → owned DataModel nodes (U3), via app_contains. */
  dataModelsByModule: Map<string, AppNode[]>;
  /** Screen node id → target screen names (U2 + S2 navigates_to edges). */
  navTargetsByScreenId: Map<string, string[]>;
  /** module id → permission-backed capability ids (S1), via manifest uses_capability. */
  permissionCapsByModule: Map<string, string[]>;
  /** module id → owned BackgroundComponent nodes (S2), via app_contains. */
  backgroundByModule: Map<string, AppNode[]>;
  /** module id → launcher-entry screen names (S2 AppEntry), via app_contains. */
  appEntriesByModule: Map<string, string[]>;
  /** module id → deep-link resource names (S2 exposes), attributed via the exposing node. */
  deeplinksByModule: Map<string, string[]>;
  /** Screen node id → hosted xml-layout screen names (S2 set-content-view). */
  layoutsByScreenId: Map<string, string[]>;
}

/**
 * Assemble the analysis brief for one module. `fileFilter` narrows a SPLIT
 * unit's brief to its member files (interface/screens/models); module-level
 * facts (DI, flows, manifest components) stay whole-module — they are shared
 * context every slice of the module needs.
 */
export function assembleModuleBrief(
  moduleId: string,
  input: AssemblyInput,
  fileFilter?: ReadonlySet<string>
): ModuleBrief {
  const module = input.moduleById.get(moduleId);
  const moduleName = module?.name ?? moduleId;
  const nodeIds = input.moduleIdToNodeIds.get(moduleId) ?? [];
  const nodes = nodeIds
    .map((id) => input.nodeById.get(id))
    .filter((n): n is Node => n !== undefined)
    .filter((n) => !fileFilter || fileFilter.has(n.filePath));
  const inFilter = (file: string | undefined): boolean =>
    !fileFilter || (file !== undefined && fileFilter.has(file));

  return {
    moduleId,
    moduleName,
    role: typeof module?.attrs?.role === 'string' ? module.attrs.role : module?.subtype,
    layer: typeof module?.attrs?.layer === 'string' ? module.attrs.layer : undefined,
    symbolCount:
      typeof module?.attrs?.symbolCount === 'number' ? module.attrs.symbolCount : undefined,
    publicInterface: extractPublicInterface(nodes),
    capabilities: extractCapabilities(nodes),
    dependencies: extractDependencies(moduleId, input),
    impliedDependencies: input.liftedDeps.get(moduleId) ?? [],
    roleCounts: asRecord(module?.attrs?.roleCounts),
    screens: (input.screensByModule.get(moduleId) ?? [])
      .filter((n) => inFilter(n.platformRef?.file))
      .map((n) => toScreenBrief(n, input))
      .sort((a, b) => a.name.localeCompare(b.name)),
    dataModels: (input.dataModelsByModule.get(moduleId) ?? [])
      .filter((n) => inFilter(n.platformRef?.file))
      .map(toDataModelBrief)
      .sort((a, b) => a.name.localeCompare(b.name)),
    di: asDiFacts(module?.attrs?.di),
    flows: asFlowFacts(module?.attrs?.flows),
    constants: asConstantsFacts(module?.attrs?.constants),
    testContract: asTestContractFacts(module?.attrs?.testContract),
    permissionCapabilities: input.permissionCapsByModule.get(moduleId) ?? [],
    backgroundComponents: (input.backgroundByModule.get(moduleId) ?? [])
      .map(toBackgroundBrief)
      .sort((a, b) => a.name.localeCompare(b.name)),
    appEntries: [...(input.appEntriesByModule.get(moduleId) ?? [])].sort(),
    deeplinks: [...(input.deeplinksByModule.get(moduleId) ?? [])].sort(),
  };
}

/** A persisted Screen node → the brief entry, with its navigation fan-out. */
function toScreenBrief(node: AppNode, input: AssemblyInput): ScreenBrief {
  return {
    name: node.name,
    file: node.platformRef?.file,
    subtype: node.subtype,
    navigatesTo: input.navTargetsByScreenId.get(node.id) ?? [],
    layouts: input.layoutsByScreenId.get(node.id) ?? [],
  };
}

/** A persisted BackgroundComponent node → the brief entry the plan renders. */
function toBackgroundBrief(node: AppNode): BackgroundComponentBrief {
  const attrs = node.attrs ?? {};
  return {
    name: node.name,
    subtype: node.subtype ?? 'service',
    exported: typeof attrs.exported === 'boolean' ? attrs.exported : undefined,
    foregroundServiceType:
      typeof attrs.foregroundServiceType === 'string' ? attrs.foregroundServiceType : undefined,
    harmonyModule: typeof attrs.harmonyModule === 'string' ? attrs.harmonyModule : undefined,
    harmonyNote: typeof attrs.harmonyNote === 'string' ? attrs.harmonyNote : undefined,
    file: node.platformRef?.file,
  };
}

/** A persisted DataModel node → the brief entry the plan renders. */
function toDataModelBrief(node: AppNode): DataModelBrief {
  const attrs = node.attrs ?? {};
  return {
    name: node.name,
    subtype: node.subtype ?? 'entity',
    tableName: typeof attrs.tableName === 'string' ? attrs.tableName : undefined,
    file: node.platformRef?.file,
    fields: Array.isArray(attrs.fields) ? (attrs.fields as FieldSchema[]) : [],
  };
}

function asRecord(v: unknown): Record<string, number> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, number>) : undefined;
}
function asDiFacts(v: unknown): DiFacts | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as DiFacts) : undefined;
}
function asFlowFacts(v: unknown): FlowFacts | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as FlowFacts) : undefined;
}
function asConstantsFacts(v: unknown): ConstantsFacts | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as ConstantsFacts) : undefined;
}
function asTestContractFacts(v: unknown): TestContractFacts | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as TestContractFacts) : undefined;
}

/** Public types + top-level functions, non-test, non-private/internal. */
export function extractPublicInterface(nodes: Node[]): InterfaceMember[] {
  const members: InterfaceMember[] = [];
  for (const n of nodes) {
    if (!INTERFACE_KINDS.has(n.kind)) continue;
    if (TEST_PATH_RE.test(n.filePath)) continue;
    if (n.visibility === 'private' || n.visibility === 'internal') continue;
    members.push({
      kind: n.kind,
      name: n.name,
      qualifiedName: n.qualifiedName,
      visibility: n.visibility,
      signature: n.signature,
      file: n.filePath,
    });
  }
  // Types first, then functions; stable by qualified name.
  return members.sort(
    (a, b) => typeRank(a.kind) - typeRank(b.kind) || a.qualifiedName.localeCompare(b.qualifiedName)
  );
}

/** Capabilities the module uses, from its import FQNs. */
function extractCapabilities(nodes: Node[]): CapabilityUse[] {
  const byId = new Map<string, Set<string>>();
  for (const n of nodes) {
    if (n.kind !== 'import') continue;
    const id = apiToCapability(n.name);
    if (id === null) continue;
    let ev = byId.get(id);
    if (!ev) {
      ev = new Set<string>();
      byId.set(id, ev);
    }
    if (ev.size < 8) ev.add(n.name);
  }
  return [...byId.keys()].sort().map((id) => ({
    id,
    harmony: harmonyTargetFor(id),
    evidence: [...byId.get(id)!].sort(),
  }));
}

/** Declared dependency modules, each with its source-side public surface. */
function extractDependencies(moduleId: string, input: AssemblyInput): DependencyBrief[] {
  const deps = input.moduleDeps.get(moduleId) ?? [];
  const briefs: DependencyBrief[] = [];
  for (const depId of [...deps].sort()) {
    const depModule = input.moduleById.get(depId);
    const depNodeIds = input.moduleIdToNodeIds.get(depId) ?? [];
    const depNodes = depNodeIds
      .map((id) => input.nodeById.get(id))
      .filter((n): n is Node => n !== undefined);
    briefs.push({
      moduleName: depModule?.name ?? depId,
      publicMembers: extractPublicInterface(depNodes)
        .slice(0, 30)
        .map((m) => `${m.kind} ${m.name}`),
    });
  }
  return briefs;
}

function typeRank(kind: NodeKind): number {
  if (kind === 'interface') return 0;
  if (kind === 'class') return 1;
  if (kind === 'enum') return 2;
  return 3; // function
}
