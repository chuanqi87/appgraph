/**
 * S2 · Android structural facts the migration graph previously dropped.
 *
 * S1 (`manifest-capabilities`) keeps only the Permission/Capability nodes from
 * each AndroidManifest and discards the rest of `extractManifest`'s output —
 * activities, services/receivers/providers, launcher entries, and deep links
 * never reached the migration graph, and `liftNavigation` (explicit-intent
 * `startActivity`/`startService` edges) was never wired in. View-system apps
 * therefore had isolated `xml-layout` screens with zero navigation.
 *
 * This pass closes those gaps with three deterministic steps:
 *   1. Re-extract every shippable manifest, this time KEEPING the structural
 *      nodes (Screen(activity) / BackgroundComponent / AppEntry / Resource) and
 *      their requires_permission/exposes edges; components get their HarmonyOS
 *      translation target (`harmonyComponentTargetFor`), and a service's
 *      `foregroundServiceType` becomes an auto-verifiable
 *      `background.foreground-service` capability on its owning module.
 *   2. Reuse `liftNavigation` verbatim over an AppGraph shell of those nodes:
 *      explicit-intent navigates_to, startService backed_by, and
 *      convention-discovered Fragment/Dialog screens.
 *   3. Link each Activity/Fragment screen to the `xml-layout` Screen it hosts
 *      (`setContentView`/`inflate(R.layout.…)`), via the U6 layout-screen id
 *      formula — no node lookup needed, but edges are only emitted for layouts
 *      U6 actually produced (no dangling references).
 *
 * Capability/Permission nodes stay S1's responsibility (its enriched nodes must
 * not be overwritten by un-enriched re-extractions); the single exception is
 * the foreground-service capability, which S2 emits fully enriched itself.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  APP_GRAPH_SCHEMA_VERSION,
  AppEdge,
  AppGraph,
  AppNode,
  CoverageWarning,
  capabilityMatchKey,
  makeEdgeId,
  makeNodeId,
  screenMatchKey,
} from '../schema';
import { extractManifest } from '../extractors/android/manifest';
import { liftNavigation } from '../lift/android-navigation';
import { harmonyComponentTargetForClass, harmonyTargetFor } from './api-capabilities';
import {
  ModuleRef,
  attributeModule,
  findManifests,
  moduleDirIndex,
  topSegment,
} from './manifest-capabilities';
import { isTestPath } from './shared';

/** Manifest node kinds S2 persists (S1 owns Permission/Capability). */
const KEPT_NODE_KINDS = new Set(['Screen', 'BackgroundComponent', 'AppEntry', 'Resource']);
/** Manifest edge kinds S2 persists. */
const KEPT_EDGE_KINDS = new Set(['requires_permission', 'exposes']);

const FOREGROUND_CAP_ID = 'background.foreground-service';

/** `setContentView(R.layout.x)` / `inflate(R.layout.x, …)` in a screen class. */
const LAYOUT_REF_RE = /(?:setContentView|inflate)\s*\(\s*R\.layout\.(\w+)/g;
/**
 * ViewBinding: `BriefContactBinding.inflate(…)` — AGP derives the Binding
 * class name from the layout file (brief_contact.xml → BriefContactBinding),
 * so the inverse mapping is deterministic.
 */
const VIEW_BINDING_RE = /\b([A-Z]\w*)Binding\.inflate\s*\(/g;
/** Files whose primary type is a screen by naming convention. */
const SCREEN_FILE_RE = /(Activity|Fragment|Dialog)\.(kt|java)$/;

const EXCLUDED_DIRS = new Set([
  'build',
  '.git',
  '.gradle',
  '.idea',
  'node_modules',
  '.appgraph',
  '.codegraph',
  '.migration',
]);

/**
 * A screen "hosts" an xml-layout Screen via one of these evidence kinds — the
 * shared predicate every consumer (V1 diff, plan assembly, MCP facts) uses so
 * hosted layouts are treated as implementation details, not standalone screens.
 */
export function isLayoutHostingEdge(edge: AppEdge): boolean {
  return (
    edge.kind === 'app_contains' &&
    (edge.attrs?.via === 'set-content-view' || edge.attrs?.via === 'view-binding')
  );
}

export interface AndroidStructureResult {
  nodes: AppNode[];
  edges: AppEdge[];
  warnings: CoverageWarning[];
  stats: {
    activityScreens: number;
    backgroundComponents: number;
    appEntries: number;
    deeplinks: number;
    intentNavEdges: number;
    backedByEdges: number;
    layoutLinks: number;
  };
}

/** Resolve a component class's declared supertypes (Kotlin `: Base` / Java
 *  `extends`), keyed by its simple name and optional fully-qualified name. */
export type SuperTypeResolver = (
  simpleName: string,
  fqName?: string
) => readonly string[] | undefined;

/**
 * Extract the Android structural layer. `knownLayoutScreenIds` are the
 * `xml-layout` Screen node ids U6 produced in the same semantics run — layout
 * hosting edges are emitted only against those. `resolveSuperTypes` (optional)
 * refines a background component's HarmonyOS target by its framework base class
 * (VpnService / InCallService / media services / TileService); when absent or a
 * class can't be resolved, the manifest-subtype mapping is used unchanged.
 */
export function detectAndroidStructure(
  projectRoot: string,
  modules: ModuleRef[],
  knownLayoutScreenIds: ReadonlySet<string>,
  resolveSuperTypes?: SuperTypeResolver
): AndroidStructureResult {
  const dirToModule = moduleDirIndex(modules);
  const moduleByDir = new Map(modules.map((m) => [m.dir, m]));

  const nodesById = new Map<string, AppNode>();
  const edgesById = new Map<string, AppEdge>();
  const warnings: CoverageWarning[] = [];
  const addNode = (node: AppNode): void => {
    if (!nodesById.has(node.id)) nodesById.set(node.id, node);
  };
  const addEdge = (edge: AppEdge): void => {
    if (!edgesById.has(edge.id)) edgesById.set(edge.id, edge);
  };

  // 1 · Manifest structural nodes + edges (previously dropped by S1).
  const stats = {
    activityScreens: 0,
    backgroundComponents: 0,
    appEntries: 0,
    deeplinks: 0,
    intentNavEdges: 0,
    backedByEdges: 0,
    layoutLinks: 0,
  };
  for (const abs of findManifests(projectRoot).sort()) {
    const relPath = toPosix(relative(projectRoot, abs));
    const owner = attributeModule(relPath, dirToModule);
    const label = owner?.name ?? topSegment(relPath);

    let source: string;
    try {
      source = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    // S1 already surfaced this extraction's warnings — don't duplicate them.
    const extraction = extractManifest(relPath, source, label);

    const permissionById = new Map(
      extraction.nodes.filter((n) => n.kind === 'Permission').map((n) => [n.id, n])
    );
    for (const node of extraction.nodes) {
      if (!KEPT_NODE_KINDS.has(node.kind)) continue;
      addNode(node.kind === 'BackgroundComponent' ? enrichComponent(node, resolveSuperTypes) : node);
      if (owner && node.kind !== 'Resource') {
        addEdge({
          id: makeEdgeId('app_contains', owner.id, node.id),
          kind: 'app_contains',
          from: owner.id,
          to: node.id,
          provenance: 'manifest',
          confidence: 1,
        });
      }
      if (
        owner &&
        node.kind === 'BackgroundComponent' &&
        typeof node.attrs?.foregroundServiceType === 'string'
      ) {
        const cap = foregroundCapabilityNode();
        addNode(cap);
        addEdge({
          id: makeEdgeId('uses_capability', owner.id, cap.id),
          kind: 'uses_capability',
          from: owner.id,
          to: cap.id,
          provenance: 'manifest',
          confidence: 1,
          attrs: { source: 'manifest', evidence: 'foregroundServiceType' },
        });
      }
    }
    for (const edge of extraction.edges) {
      if (!KEPT_EDGE_KINDS.has(edge.kind)) continue;
      addEdge(edge);
      // Keep the Permission node a requires_permission edge points at, so the
      // edge never dangles even before/without the capabilities stage.
      const perm = permissionById.get(edge.to);
      if (perm) addNode(perm);
    }
  }

  // 2 · Explicit-intent navigation + convention-discovered screens (reuse
  // liftNavigation verbatim over a shell of the manifest nodes).
  const shell: AppGraph = {
    schemaVersion: APP_GRAPH_SCHEMA_VERSION,
    platform: 'android',
    app: { name: '', packageName: '' },
    fidelity: 'source-project',
    supportedKinds: ['Screen', 'BackgroundComponent'],
    nodes: [...nodesById.values()].filter(
      (n) => n.kind === 'Screen' || n.kind === 'BackgroundComponent'
    ),
    edges: [],
    coverageWarnings: [],
    navFrameworks: [],
  };
  const lift = liftNavigation(shell, projectRoot);
  for (const node of lift.nodes) {
    addNode(node);
    const dir = typeof node.attrs?.module === 'string' ? node.attrs.module : undefined;
    const owner = dir !== undefined ? moduleByDir.get(dir) : undefined;
    if (owner) {
      addEdge({
        id: makeEdgeId('app_contains', owner.id, node.id),
        kind: 'app_contains',
        from: owner.id,
        to: node.id,
        provenance: 'lifted',
        confidence: 0.85,
      });
    }
  }
  lift.edges.forEach(addEdge);
  warnings.push(...lift.warnings);

  // 3 · Screen → hosted xml-layout Screen (setContentView / R.layout inflate /
  // ViewBinding). A screen-named class with a layout it provably hosts is a
  // screen even when neither the manifest nor navigation discovered it — that
  // is exactly the shape of a View-system Fragment (koler et al.).
  const screenByName = new Map<string, AppNode>();
  for (const node of nodesById.values()) {
    if (node.kind === 'Screen') screenByName.set(node.name.toLowerCase(), node);
  }
  for (const abs of findScreenSourceFiles(projectRoot).sort()) {
    const relPath = toPosix(relative(projectRoot, abs));
    const className = relPath.split('/').pop()!.replace(/\.(kt|java)$/, '');

    let source: string;
    try {
      source = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const layoutRefs = new Map<string, string>(); // layout node id → via
    for (const m of source.matchAll(LAYOUT_REF_RE)) {
      layoutRefs.set(layoutScreenId(m[1]!), 'set-content-view');
    }
    for (const m of source.matchAll(VIEW_BINDING_RE)) {
      const id = layoutScreenId(pascalToSnake(m[1]!));
      if (!layoutRefs.has(id)) layoutRefs.set(id, 'view-binding');
    }

    let screen: AppNode | undefined;
    for (const [layoutId, via] of [...layoutRefs].sort()) {
      if (!knownLayoutScreenIds.has(layoutId)) continue;
      screen ??=
        screenByName.get(className.toLowerCase()) ??
        conventionScreen(className, relPath, screenByName, addNode, (edge) => addEdge(edge), moduleByDir);
      addEdge({
        id: makeEdgeId('app_contains', screen.id, layoutId),
        kind: 'app_contains',
        from: screen.id,
        to: layoutId,
        provenance: 'source-static',
        confidence: 0.9,
        attrs: { via, evidenceFile: relPath },
      });
    }
  }

  for (const node of nodesById.values()) {
    if (node.kind === 'Screen' && node.subtype === 'activity') stats.activityScreens++;
    else if (node.kind === 'BackgroundComponent') stats.backgroundComponents++;
    else if (node.kind === 'AppEntry') stats.appEntries++;
    else if (node.kind === 'Resource' && node.subtype === 'deeplink') stats.deeplinks++;
  }
  for (const edge of edgesById.values()) {
    if (edge.kind === 'navigates_to') stats.intentNavEdges++;
    else if (edge.kind === 'backed_by') stats.backedByEdges++;
    else if (isLayoutHostingEdge(edge)) stats.layoutLinks++;
  }

  return {
    nodes: [...nodesById.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edgesById.values()].sort((a, b) => a.id.localeCompare(b.id)),
    warnings,
    stats,
  };
}

/**
 * Attach the HarmonyOS translation target to a background component, refined by
 * its framework base class when the resolver can recover it (VpnService,
 * InCallService, media services, TileService), else by manifest subtype.
 */
function enrichComponent(node: AppNode, resolveSuperTypes?: SuperTypeResolver): AppNode {
  const fqName = typeof node.platformRef?.symbol === 'string' ? node.platformRef.symbol : undefined;
  const supers = resolveSuperTypes?.(node.name, fqName);
  const target = harmonyComponentTargetForClass(node.subtype, supers);
  if (!target) return node;
  return {
    ...node,
    attrs: { ...node.attrs, harmonyModule: target.module, harmonyNote: target.note },
  };
}

/** Fully-enriched foreground-service capability (same shape as S1's caps). */
function foregroundCapabilityNode(): AppNode {
  const matchKey = capabilityMatchKey(FOREGROUND_CAP_ID as never);
  const target = harmonyTargetFor(FOREGROUND_CAP_ID);
  return {
    id: makeNodeId('android', 'Capability', matchKey),
    kind: 'Capability',
    matchKey,
    name: FOREGROUND_CAP_ID,
    platform: 'android',
    provenance: 'manifest',
    fidelity: 'source-project',
    confidence: 1,
    attrs: {
      derivedFrom: 'android:foregroundServiceType',
      ...(target
        ? { harmonyModule: target.module, harmonyNote: target.note, constructs: target.constructs ?? [] }
        : {}),
    },
  };
}

/** The `xml-layout` Screen node id U6 produces for `res/layout/<stem>.xml`. */
function layoutScreenId(stem: string): string {
  return makeNodeId('android', 'Screen', screenMatchKey(`layout_${stem}`));
}

/** `BriefContactBinding`'s layout stem: PascalCase → snake_case. */
function pascalToSnake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * Synthesize a Screen for a screen-named class discovered via the layout it
 * hosts (same shape as liftNavigation's convention screens), attributed to its
 * module by source path.
 */
function conventionScreen(
  className: string,
  relPath: string,
  screenByName: Map<string, AppNode>,
  addNode: (n: AppNode) => void,
  addEdge: (e: AppEdge) => void,
  moduleByDir: Map<string, ModuleRef>
): AppNode {
  const subtype = /Fragment$/.test(className)
    ? 'fragment'
    : /Dialog$/.test(className)
      ? 'dialog'
      : 'activity';
  const matchKey = screenMatchKey(className);
  const node: AppNode = {
    id: makeNodeId('android', 'Screen', matchKey),
    kind: 'Screen',
    matchKey,
    name: className,
    platform: 'android',
    subtype,
    platformRef: { file: relPath, symbol: className },
    provenance: 'source-static',
    fidelity: 'source-project',
    confidence: 0.9,
    attrs: { discoveredBy: 'layout-binding', module: moduleOf(relPath) },
  };
  addNode(node);
  screenByName.set(className.toLowerCase(), node);
  const owner = moduleByDir.get(moduleOf(relPath));
  if (owner) {
    addEdge({
      id: makeEdgeId('app_contains', owner.id, node.id),
      kind: 'app_contains',
      from: owner.id,
      to: node.id,
      provenance: 'lifted',
      confidence: 0.85,
    });
  }
  return node;
}

/** Module dir from a `<module>/src/...` path (same rule as lift/android-navigation). */
function moduleOf(relPath: string): string {
  const idx = relPath.indexOf('/src/');
  return idx > 0 ? relPath.slice(0, idx) : 'root';
}

/** Every shippable `*Activity|*Fragment|*Dialog` Kotlin/Java source file. */
function findScreenSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) walk(full);
      } else if (SCREEN_FILE_RE.test(entry.name) && !isTestSource(full)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

function isTestSource(path: string): boolean {
  return isTestPath(toPosix(path));
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}
