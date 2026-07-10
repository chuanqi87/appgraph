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
import {
  HarmonyTarget,
  apiToCapability,
  concurrencyTargetFor,
  harmonyTargetFor,
} from '../../appgraph/detect/api-capabilities';
import { ConstantsFacts } from '../../appgraph/detect/constants';
import { DiFacts } from '../../appgraph/detect/di';
import { FlowFacts } from '../../appgraph/detect/flows';
import { FieldSchema } from '../../appgraph/detect/entities';
import { SqliteSchemaHint } from '../../appgraph/detect/sqldelight';
import { ControlNode } from '../../appgraph/detect/resources';
import { TestContractFacts } from '../../appgraph/detect/tests';
import { isBuildFilePath, isTestPath } from '../../appgraph/detect/shared';

/** How many of a module's `<string>` keys to sample in the resource inventory. */
const MAX_RESOURCE_STRING_KEYS = 30;

/** Public interface kinds — the cross-module surface (types + top-level fns). */
const INTERFACE_KINDS = new Set<NodeKind>(['class', 'interface', 'enum', 'function']);

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

/**
 * A layout's compact control tree (T2), carried on the screen that renders it.
 * For a hosting Activity/Fragment this is its hosted `xml-layout`'s tree; for a
 * standalone `xml-layout` screen it is its own.
 */
export interface ControlTree {
  /** Layout file stem this tree came from (`activity_main`). */
  layout: string;
  /** Total control-element count in the source layout (pre-truncation). */
  controlCount: number;
  /** The layout's root control element (bounded — see `ControlNode`). */
  root: ControlNode;
  /** True when the source tree was elided by the node/depth cap. */
  truncated?: boolean;
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
  /** Compact control tree(s) of this screen's layout(s) (T2), absent when none. */
  controls?: ControlTree[];
}

/**
 * A module's XML resource inventory (T2), aggregated from its `res/values/*`
 * Resource nodes — the source-of-truth for the target's
 * `resources/base/element/*.json`. A module-level fact (rendered on a split
 * module's first slice only, like DI/flows).
 */
export interface ResourceBrief {
  /** Per-resource-type entry counts across the module (string/color/dimen/style…). */
  byType: Record<string, number>;
  /** Total resource entries across the module's values files. */
  total: number;
  /** How many `res/values/*` files back this inventory. */
  fileCount: number;
  /** Sample `<string>` key names (sorted, capped at `MAX_RESOURCE_STRING_KEYS`). */
  stringKeys: string[];
  /** How many string keys were omitted past the cap. */
  stringKeyOverflow: number;
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

/**
 * A custom View subclass (P1-6). ArkUI has no class inheritance for UI, so a
 * class extending an Android View can't be translated 1:1 — it must be rebuilt
 * as a `@Component` struct / `@Builder`. Surfacing them warns the agent about
 * the inheritance→composition rewrite the dogfood pass showed it silently missed.
 */
export interface CustomViewBrief {
  name: string;
  /** The Android View base class it extends (e.g. `LinearLayout`, `View`). */
  superClass: string;
  /** Source file anchor (project-relative). */
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

/**
 * A functional cluster within a module (P1-3): the intersection of a subdivision
 * / cross-module Feature (M2) with this module's files. Gives the conversion
 * agent a FUNCTIONAL grouping of the module's files instead of a flat list, so a
 * large module can be migrated cluster-by-cluster.
 */
export interface FeatureSectionBrief {
  /** Feature hub name (advisory M2 label). */
  name: string;
  /** Feature role: 'subdivision' | 'cross-module'. */
  role: string;
  cohesion: number;
  /** Low-trust cross-module grab-bag (P1-4 attrs.weak). */
  weak?: boolean;
  /** This module's files that belong to the cluster (project-relative, sorted). */
  files: string[];
}

/** Everything the analysis knows about one source module — the brief's data. */
export interface ModuleBrief {
  moduleId: string;
  moduleName: string;
  role?: string;
  layer?: string;
  /** 'dev-only' when this module is dev-support (benchmark/test/lint). */
  necessity?: string;
  /** Code symbols assigned to this module (size signal for unit planning). */
  symbolCount?: number;
  /**
   * The module's source files (project-relative, sorted). For a split unit this
   * is the slice's files; for a module/merged unit it is the whole module — the
   * full file manifest the conversion agent needs (P1-3), not just the files
   * that happened to surface under a Feature section.
   */
  files: string[];
  publicInterface: InterfaceMember[];
  capabilities: CapabilityUse[];
  dependencies: DependencyBrief[];
  /** Test-scoped declared deps (testImplementation/androidTest…) — NOT migration
   *  prerequisites; listed separately so they never read as blocking. */
  testDependencies: string[];
  impliedDependencies: ImpliedDependency[];
  /** Component-role distribution across this module's symbols (U1). */
  roleCounts?: Record<string, number>;
  /** Screens this module owns (U2/U6/S2) — target pages + router config. */
  screens: ScreenBrief[];
  /** XML resource inventory (U6/T2) — target element/*.json. Module-level fact. */
  resources?: ResourceBrief;
  /** Data models this module owns (U3) — target RDB tables / interfaces. */
  dataModels: DataModelBrief[];
  /**
   * Handwritten-SQLite persistence hint (U3b) — table names + resolvable column
   * keys where the schema is assembled from `KEY_*` constants and can't be
   * statically evaluated into a typed model. Advisory (never a V2 entity check).
   */
  sqliteSchema?: SqliteSchemaHint;
  /** Custom View subclasses (P1-6) — inheritance→composition rewrite anchors. */
  customViews: CustomViewBrief[];
  /** Functional clusters within the module (P1-3) — file grouping by Feature. */
  featureSections: FeatureSectionBrief[];
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
  /** declared module→module depends_on, main scope only (from → set of to). */
  moduleDeps: Map<string, string[]>;
  /** declared module→module depends_on under test configurations only. */
  moduleTestDeps: Map<string, string[]>;
  /** lifted module→module coupling (from → advisory dependencies). */
  liftedDeps: Map<string, ImpliedDependency[]>;
  /** module id → owned Screen nodes (U2/U6), via app_contains. */
  screensByModule: Map<string, AppNode[]>;
  /** module id → owned values Resource nodes (U6), via app_contains. */
  resourcesByModule: Map<string, AppNode[]>;
  /** module id → owned DataModel nodes (U3), via app_contains. */
  dataModelsByModule: Map<string, AppNode[]>;
  /** Screen node id → target screen names (U2 + S2 navigates_to edges). */
  navTargetsByScreenId: Map<string, string[]>;
  /** Screen node id → compact control tree(s) of its layout(s) (T2). */
  controlsByScreenId: Map<string, ControlTree[]>;
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
  /** module id → custom View subclasses it declares (P1-6). */
  customViewsByModule: Map<string, CustomViewBrief[]>;
  /** module id → functional clusters (P1-3), Feature ∩ module files. */
  featureSectionsByModule: Map<string, FeatureSectionBrief[]>;
  /**
   * Code node ids of `@Preview`/`@DevicePreviews` composables (T1-3): tooling-only
   * preview functions that are not real public surface. Excluded from every
   * public-interface extraction (module brief, dep surface, T3 baseline).
   */
  previewComposableIds: ReadonlySet<string>;
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
    necessity: typeof module?.attrs?.necessity === 'string' ? module.attrs.necessity : undefined,
    symbolCount:
      typeof module?.attrs?.symbolCount === 'number' ? module.attrs.symbolCount : undefined,
    files: [...new Set(nodes.map((n) => n.filePath))].sort(),
    publicInterface: extractPublicInterface(nodes, input.previewComposableIds),
    capabilities: extractCapabilities(nodes),
    dependencies: extractDependencies(moduleId, input),
    testDependencies: [...(input.moduleTestDeps.get(moduleId) ?? [])]
      .map((id) => input.moduleById.get(id)?.name ?? id)
      .sort(),
    impliedDependencies: input.liftedDeps.get(moduleId) ?? [],
    roleCounts: asRecord(module?.attrs?.roleCounts),
    screens: (input.screensByModule.get(moduleId) ?? [])
      .filter((n) => inFilter(n.platformRef?.file))
      .map((n) => toScreenBrief(n, input))
      .sort((a, b) => a.name.localeCompare(b.name)),
    // Resources are a whole-module fact (like DI/flows) — assembled un-filtered;
    // a split sibling suppresses the RENDER, not the assembly (T2 / T1-2).
    resources: toResourceBrief(input.resourcesByModule.get(moduleId) ?? []),
    dataModels: (input.dataModelsByModule.get(moduleId) ?? [])
      .filter((n) => inFilter(n.platformRef?.file))
      .map(toDataModelBrief)
      .sort((a, b) => a.name.localeCompare(b.name)),
    // Handwritten-SQLite hint is a whole-module fact (like DI/flows) — assembled
    // un-filtered; a split sibling suppresses the RENDER, not the assembly.
    sqliteSchema: asSqliteHint(module?.attrs?.sqlite),
    customViews: (input.customViewsByModule.get(moduleId) ?? [])
      .filter((v) => inFilter(v.file))
      .sort((a, b) => a.name.localeCompare(b.name)),
    featureSections: (input.featureSectionsByModule.get(moduleId) ?? [])
      .map((s) => ({ ...s, files: s.files.filter((f) => inFilter(f)) }))
      .filter((s) => s.files.length > 0),
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
  const controls = input.controlsByScreenId.get(node.id);
  return {
    name: node.name,
    file: node.platformRef?.file,
    subtype: node.subtype,
    navigatesTo: input.navTargetsByScreenId.get(node.id) ?? [],
    layouts: input.layoutsByScreenId.get(node.id) ?? [],
    ...(controls && controls.length > 0 ? { controls } : {}),
  };
}

/**
 * Aggregate a module's `res/values/*` Resource nodes into one inventory (T2):
 * per-type counts, total entries, and a bounded sample of `<string>` keys. The
 * agent uses this to build the target `resources/base/element/*.json`. Returns
 * undefined when the module owns no such resources (keeps the field additive).
 */
function toResourceBrief(nodes: AppNode[]): ResourceBrief | undefined {
  if (nodes.length === 0) return undefined;
  const byType: Record<string, number> = {};
  const stringKeys = new Set<string>();
  let total = 0;
  for (const n of nodes) {
    const attrs = n.attrs ?? {};
    const bt = attrs.byType;
    if (bt && typeof bt === 'object' && !Array.isArray(bt)) {
      for (const [k, v] of Object.entries(bt as Record<string, unknown>)) {
        if (typeof v === 'number') byType[k] = (byType[k] ?? 0) + v;
      }
    }
    if (typeof attrs.entryCount === 'number') total += attrs.entryCount;
    if (Array.isArray(attrs.stringNames)) {
      for (const s of attrs.stringNames) if (typeof s === 'string') stringKeys.add(s);
    }
  }
  if (total === 0 && Object.keys(byType).length === 0) return undefined;
  const allKeys = [...stringKeys].sort();
  return {
    byType,
    total,
    fileCount: nodes.length,
    stringKeys: allKeys.slice(0, MAX_RESOURCE_STRING_KEYS),
    stringKeyOverflow: Math.max(0, allKeys.length - MAX_RESOURCE_STRING_KEYS),
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
function asSqliteHint(v: unknown): SqliteSchemaHint | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const hint = v as SqliteSchemaHint;
  return Array.isArray(hint.tables) && Array.isArray(hint.columns) ? hint : undefined;
}

/**
 * Public types + top-level functions, non-test, non-private/internal.
 *
 * `excludeIds` drops nodes an external pass flagged as non-surface (T1-3 preview
 * composables) — keyed by node id so every call site (module brief, dep surface,
 * T3 baseline) filters identically.
 */
export function extractPublicInterface(
  nodes: Node[],
  excludeIds?: ReadonlySet<string>
): InterfaceMember[] {
  // Ancestor-scope index: a member whose enclosing scope is a function/method is
  // a local declaration or an anonymous-inner-class override, NOT public surface
  // (T1-3). The qualifiedName encodes the full enclosing chain, so look each
  // proper prefix up here by kind.
  const kindByQualifiedName = new Map<string, NodeKind>();
  for (const n of nodes) kindByQualifiedName.set(n.qualifiedName, n.kind);

  const members: InterfaceMember[] = [];
  for (const n of nodes) {
    if (!INTERFACE_KINDS.has(n.kind)) continue;
    if (isTestPath(n.filePath)) continue;
    // Symbols declared in a build script (build.gradle.kts, buildSrc/…) are
    // build tooling, not app surface — they never belong on the T3 baseline
    // (CatchUp's CutChangelogTask / UpdateVersion came from build.gradle.kts) (T1-8).
    if (isBuildFilePath(n.filePath)) continue;
    if (n.visibility === 'private' || n.visibility === 'internal') continue;
    // Anonymous classes (`<Listener$anon@42>`, `<anonymous>`) are extraction
    // artifacts, not exportable surface — and their names embed line numbers,
    // so letting them in makes the T3 baseline both unfulfillable and unstable.
    if (n.name.startsWith('<')) continue;
    // @Preview/@DevicePreviews composables — tooling-only, not real surface (T1-3).
    if (excludeIds?.has(n.id)) continue;
    // A member scoped under a function/method (a local fn, or a named override
    // on an anonymous inner class) is not a public export (T1-3); a genuine
    // nested *type* — enclosed only by class/interface/object/enum — is kept.
    if (enclosedByCallable(n.qualifiedName, kindByQualifiedName)) continue;
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

/**
 * True when some enclosing scope of `qualifiedName` is a function/method (the
 * member is a local / anonymous-inner-class override) or an anonymous scope.
 * The qualifiedName is `package::Outer::Inner…`: segment 0 is the package, the
 * rest is the type-nesting chain, so proper prefixes past the package name the
 * enclosing scopes. A genuine nested type (all ancestors class/interface/object/
 * enum) returns false and stays on the public surface.
 */
function enclosedByCallable(
  qualifiedName: string,
  kindByQualifiedName: Map<string, NodeKind>
): boolean {
  const segs = qualifiedName.split('::');
  if (segs.length <= 2) return false; // `package::Name` / bare `Name` — top-level.
  // Proper prefixes, deepest first, down to (but excluding) the bare package.
  for (let i = segs.length - 1; i >= 2; i--) {
    const kind = kindByQualifiedName.get(segs.slice(0, i).join('::'));
    if (kind === 'function' || kind === 'method') return true;
  }
  // An anonymous scope anywhere in the ancestry (`Outer::<anon>::member`).
  for (let i = 1; i < segs.length - 1; i++) {
    if (segs[i]!.startsWith('<')) return true;
  }
  return false;
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
  return [...byId.keys()].sort().map((id) => {
    const evidence = [...byId.get(id)!].sort();
    // concurrency.async's target depends on the module's ACTUAL async framework
    // (Kotlin coroutines vs RxJava, or both) — pick it from this module's evidence.
    const harmony = id === 'concurrency.async' ? concurrencyTargetFor(evidence) : harmonyTargetFor(id);
    return { id, harmony, evidence };
  });
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
      publicMembers: extractPublicInterface(depNodes, input.previewComposableIds)
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
