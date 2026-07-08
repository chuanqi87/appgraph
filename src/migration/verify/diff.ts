/**
 * M4 · verification — does the TARGET HarmonyOS project (produced by an
 * external migration agent) preserve the source's capabilities, interface, and
 * screens? This is appgraph's acceptance gate: the agent migrates, then runs
 * `migrate verify --target <harmonyProject>` and works the reported gaps.
 *
 * Symbol-level diff:
 *   - Target capabilities/screens/exports come from the community tree-sitter
 *     index of the generated code (`verify/target-graph.ts`) — the SAME engine
 *     the source side uses, so both halves are lifted identically.
 *   - Capability coverage runs appgraph's `compareAppGraphs`; a capability
 *     the source uses but the target never references is a `missingInTarget` gap.
 *   - Interface fidelity (T3): for each SOURCE module, is every public member
 *     represented by a target export? The baseline is the source module's
 *     `attrs.publicInterface` persisted by `migrate plan`.
 *   - Structural validity (T4): whether the target could be indexed at all.
 */

import {
  APP_GRAPH_SCHEMA_VERSION,
  AppEdge,
  AppGraph,
  AppNode,
  AppNodeKind,
  makeEdgeId,
} from '../../appgraph/schema';
import { MigrationCoverageReport, compareAppGraphs } from './compare';
import { MigrationGraph } from '../types';
import { Ledger } from '../ledger';
import { MigrationPlan } from '../plan';
import { isLayoutHostingEdge } from '../../appgraph/detect/android-structure';
import { VERIFIABLE_SPECS } from './capability-markers';
import {
  ArkExport,
  TargetStructural,
  resolveTargetSurface,
} from './target-graph';
import {
  diffEntitySchemas,
  diffNavigation,
  diffScreens,
  EntitySchemaDiff,
  NavDiff,
  NavEdge,
  ScreenDiff,
} from './structure-diff';

/** Per-module interface fidelity: are the source's public members represented? */
export interface InterfaceFidelity {
  moduleName: string;
  sourceCount: number;
  matchedCount: number;
  /** Source member names with no corresponding target export (high-risk gaps). */
  missing: string[];
  /**
   * How target exports were scoped: 'ledger-paths' when the module's unit
   * registered target paths (most precise), 'module-path' when target files
   * matching the module name were found, 'global' when neither (honest
   * fallback — matches anywhere).
   */
  scope: 'ledger-paths' | 'module-path' | 'global';
}

export interface VerifyResult {
  report: MigrationCoverageReport;
  /** HarmonyOS Capability + Screen nodes recovered from the generated code. */
  targetNodes: AppNode[];
  /** maps_to edges for matched capabilities (source ↔ target). */
  mapsToEdges: AppEdge[];
  /** Capability ids that carry no auto-detectable marker (construct mappings). */
  unverifiable: string[];
  fileCount: number;
  /** The target parse path — always 'codegraph' (community tree-sitter). */
  method: 'codegraph';
  /** T4 structural validity of the generated code (buildOk=false if unparseable). */
  structural: TargetStructural;
  /** T3 interface fidelity per migrated module (empty when the target is unparseable). */
  fidelity: InterfaceFidelity[];
  /** V1 · source (U2/U6) vs target screen fidelity. */
  screenDiff: ScreenDiff;
  /** V2 · source (U3) vs target entity schema fidelity. */
  entityDiff: EntitySchemaDiff;
  /** L2 · source navigation topology vs target router edges. */
  navDiff: NavDiff;
  /** L2 · source DI bindings vs target export presence (both ends). */
  diBindingDiff: DiBindingDiff;
}

/** L2 · per-binding presence of both the interface and its implementation. */
export interface DiBindingDiff {
  total: number;
  matched: number;
  /** Bindings with at least one end absent on the target. */
  missing: Array<{ iface: string; impl: string; missingEnds: string[] }>;
}

/** Verify a migrated HarmonyOS project against the source migration graph. */
export async function verifyMigration(
  graph: MigrationGraph,
  targetRoot: string,
  ledger: Ledger | null = null,
  plan: MigrationPlan | null = null
): Promise<VerifyResult> {
  const verifiableIds = new Set(VERIFIABLE_SPECS.map((x) => x.spec.id));

  // Source AppGraph: android Capability nodes that are auto-verifiable.
  const srcCapNodes = graph.nodes.filter(
    (n) => n.kind === 'Capability' && n.platform === 'android' && verifiableIds.has(idOf(n.matchKey))
  );
  const source = mkAppGraph('android', graph.source.app.packageName, srcCapNodes);

  const surface = await resolveTargetSurface(targetRoot);
  const targetCapNodes = surface.capabilityNodes;
  const targetScreenNodes = surface.screenNodes;
  const targetNodes = [...targetCapNodes, ...targetScreenNodes];
  const target = mkAppGraph('harmony', '', targetNodes);

  const report = compareAppGraphs(source, target);

  // maps_to for matched capabilities (identical matchKey → source↔target).
  const srcByKey = new Map(srcCapNodes.map((n) => [n.matchKey, n]));
  const tgtByKey = new Map(targetCapNodes.map((n) => [n.matchKey, n]));
  const mapsToEdges: AppEdge[] = [];
  for (const id of report.capabilities.matched) {
    const key = `capability:${id}`;
    const s = srcByKey.get(key);
    const t = tgtByKey.get(key);
    if (!s || !t) continue;
    mapsToEdges.push({
      id: makeEdgeId('maps_to', s.id, t.id),
      kind: 'maps_to',
      from: s.id,
      to: t.id,
      provenance: 'source-static',
      confidence: 0.9,
      attrs: { stage: 'verify', scope: 'capability' },
    });
  }

  const fidelity = surface.structural.buildOk
    ? computeInterfaceFidelity(graph, surface.exports, buildFidelityScoping(plan, ledger))
    : [];

  // V1 · screen fidelity (source U2/U6/S2 android screens ↔ target ViewTree
  // screens). An xml-layout screen hosted by an Activity/Fragment
  // (setContentView/ViewBinding app_contains) is that screen's implementation
  // detail — counting both would double-report one missing page.
  const hostedLayoutIds = new Set(
    graph.edges.filter(isLayoutHostingEdge).map((e) => e.to)
  );
  const sourceScreens = graph.nodes.filter(
    (n) => n.kind === 'Screen' && n.platform === 'android' && !hostedLayoutIds.has(n.id)
  );
  const screenDiff = diffScreens(sourceScreens, targetScreenNodes);

  // V2 · entity schema fidelity (source U3 DataModels ↔ target classes/interfaces).
  const sourceModels = graph.nodes.filter((n) => n.kind === 'DataModel' && n.platform === 'android');
  const entityDiff = diffEntitySchemas(sourceModels, surface.exports);

  // L2 · navigation topology (source navigates_to ↔ target router edges).
  const navDiff = diffNavigation(
    sourceNavEdges(graph, hostedLayoutIds),
    surface.navEdges,
    targetScreenNodes.map((n) => n.name)
  );

  // L2 · DI bindings (both interface and impl must exist on the target).
  const diBindingDiff = diffDiBindings(graph, surface.exports);

  return {
    report,
    targetNodes,
    mapsToEdges: mapsToEdges.sort((a, b) => a.id.localeCompare(b.id)),
    unverifiable: surface.unverifiable,
    fileCount: surface.fileCount,
    method: surface.method,
    structural: surface.structural,
    fidelity,
    screenDiff,
    entityDiff,
    navDiff,
    diBindingDiff,
  };
}

/** Source navigation edges (screen name → screen name), hosted layouts excluded. */
function sourceNavEdges(graph: MigrationGraph, hostedLayoutIds: Set<string>): NavEdge[] {
  const screenById = new Map(
    graph.nodes.filter((n) => n.kind === 'Screen' && n.platform === 'android').map((n) => [n.id, n])
  );
  const edges: NavEdge[] = [];
  for (const e of graph.edges) {
    if (e.kind !== 'navigates_to') continue;
    const from = screenById.get(e.from);
    const to = screenById.get(e.to);
    if (!from || !to || hostedLayoutIds.has(from.id) || hostedLayoutIds.has(to.id)) continue;
    edges.push({ from: from.name, to: to.name });
  }
  return edges;
}

/**
 * L2 · DI binding presence. The source `@Binds iface←impl` must have BOTH the
 * interface and the implementation present on the target (case-insensitive) —
 * this proves the binding survived, not that it is correctly assembled (that
 * needs statement-level IR, deferred). A ledger export rename matches too.
 */
export function diffDiBindings(graph: MigrationGraph, exports: ArkExport[]): DiBindingDiff {
  const targetNames = new Set(exports.map((e) => e.name.toLowerCase()));
  const bindings: Array<{ iface: string; impl: string }> = [];
  for (const n of graph.nodes) {
    if (n.kind !== 'ArchModule' || n.platform !== 'android') continue;
    const binds = (n.attrs?.di as { binds?: Array<{ iface: string; impl: string }> } | undefined)?.binds;
    for (const b of binds ?? []) bindings.push({ iface: b.iface, impl: b.impl });
  }
  bindings.sort((a, b) => a.iface.localeCompare(b.iface) || a.impl.localeCompare(b.impl));

  let matched = 0;
  const missing: DiBindingDiff['missing'] = [];
  for (const b of bindings) {
    const missingEnds: string[] = [];
    if (!targetNames.has(b.iface.toLowerCase())) missingEnds.push(b.iface);
    if (!targetNames.has(b.impl.toLowerCase())) missingEnds.push(b.impl);
    if (missingEnds.length === 0) matched++;
    else missing.push({ iface: b.iface, impl: b.impl, missingEnds });
  }
  return { total: bindings.length, matched, missing };
}

/**
 * T3 · interface fidelity per SOURCE module. The baseline is the source
 * ArchModule's `attrs.publicInterface` (persisted by `migrate plan`); names are
 * matched case-insensitively — translation may re-case — against the target's
 * exports. The external agent owns the target layout, so scoping is honest
 * best-effort: exports whose file path contains the module name (normalized)
 * when any exist, else the whole target.
 */
function computeInterfaceFidelity(
  graph: MigrationGraph,
  exports: ArkExport[],
  scoping: FidelityScoping
): InterfaceFidelity[] {
  const out: InterfaceFidelity[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== 'ArchModule' || node.platform !== 'android') continue;
    const publicInterface = node.attrs?.publicInterface;
    if (!Array.isArray(publicInterface) || publicInterface.length === 0) continue;
    const names = publicInterface.filter((n): n is string => typeof n === 'string');
    const exportMap = scoping.exportMapByModule.get(node.id) ?? {};

    // Ledger target paths (precise) → module-name heuristic → whole target.
    const ledgerPaths = scoping.targetPathsByModule.get(node.id);
    if (ledgerPaths && ledgerPaths.length > 0) {
      const scoped = exports.filter((e) => underAnyPrefix(e.file, ledgerPaths));
      out.push(interfaceFidelity(node.name, names, scoped, 'ledger-paths', exportMap));
      continue;
    }
    const moduleKey = normalizePath(node.name);
    const scoped = moduleKey ? exports.filter((e) => normalizePath(e.file).includes(moduleKey)) : [];
    const scope = scoped.length > 0 ? 'module-path' : 'global';
    out.push(
      interfaceFidelity(node.name, names, scope === 'module-path' ? scoped : exports, scope, exportMap)
    );
  }
  return out.sort((a, b) => a.moduleName.localeCompare(b.moduleName));
}

/** Per-module target-path scope + export rename map, unioned across its units. */
interface FidelityScoping {
  targetPathsByModule: Map<string, string[]>;
  exportMapByModule: Map<string, Record<string, string>>;
}

function buildFidelityScoping(plan: MigrationPlan | null, ledger: Ledger | null): FidelityScoping {
  const targetPathsByModule = new Map<string, string[]>();
  const exportMapByModule = new Map<string, Record<string, string>>();
  if (!plan || !ledger) return { targetPathsByModule, exportMapByModule };
  for (const unit of plan.units) {
    const entry = ledger.units[unit.id];
    if (!entry) continue;
    for (const moduleId of unit.moduleIds) {
      if (entry.targetPaths?.length) {
        const merged = new Set([...(targetPathsByModule.get(moduleId) ?? []), ...entry.targetPaths]);
        targetPathsByModule.set(moduleId, [...merged].sort());
      }
      if (entry.exportMap) {
        exportMapByModule.set(moduleId, { ...(exportMapByModule.get(moduleId) ?? {}), ...entry.exportMap });
      }
    }
  }
  return { targetPathsByModule, exportMapByModule };
}

/** POSIX-normalized "is `file` under any of the root-relative prefixes". */
function underAnyPrefix(file: string, prefixes: string[]): boolean {
  const rel = file.split('\\').join('/');
  return prefixes.some((p) => rel === p || rel.includes(p.endsWith('/') ? p : p + '/') || rel.startsWith(p));
}

/** Lowercase, strip non-alphanumerics — layout-insensitive path matching. */
function normalizePath(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Match source member names against target exports (case-insensitive). A source
 * name the ledger records as renamed (`exportMap`) is matched under its target
 * name too, so a legitimate translation rename is not reported as missing.
 */
export function interfaceFidelity(
  moduleName: string,
  sourceNames: string[],
  targetExports: ArkExport[],
  scope: InterfaceFidelity['scope'] = 'global',
  exportMap: Record<string, string> = {}
): InterfaceFidelity {
  const targetNames = new Set(targetExports.map((e) => e.name.toLowerCase()));
  const present = (n: string): boolean => {
    if (targetNames.has(n.toLowerCase())) return true;
    const renamed = exportMap[n];
    return renamed !== undefined && targetNames.has(renamed.toLowerCase());
  };
  const missing = sourceNames.filter((n) => !present(n)).sort();
  return {
    moduleName,
    sourceCount: sourceNames.length,
    matchedCount: sourceNames.length - missing.length,
    missing,
    scope,
  };
}

const SUPPORTED_KINDS: AppNodeKind[] = ['Capability', 'Screen'];

function mkAppGraph(
  platform: 'android' | 'harmony',
  packageName: string,
  nodes: AppNode[]
): AppGraph {
  return {
    schemaVersion: APP_GRAPH_SCHEMA_VERSION,
    platform,
    app: { name: '', packageName },
    fidelity: 'source-project',
    supportedKinds: SUPPORTED_KINDS,
    nodes,
    edges: [],
    coverageWarnings: [],
  };
}

/** `capability:network` → `network`. */
function idOf(matchKey: string): string {
  const idx = matchKey.indexOf(':');
  return idx >= 0 ? matchKey.slice(idx + 1) : matchKey;
}
