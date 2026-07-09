/**
 * S3 · Jetpack Navigation XML graphs (`res/navigation/*.xml`).
 *
 * A nav-graph XML is DECLARED navigation — build-file-grade truth (provenance
 * 'manifest', confidence 1), and in XML/Fragment apps (AntennaPod/koler-class)
 * it is the single richest navigation source: those apps navigate through the
 * Navigation component, which the core-graph call synthesizers cannot see.
 *
 * Per graph file this pass:
 *   - registers every destination (<fragment>/<dialog>/<activity>) as a Screen,
 *     matching an existing Screen by simple class name before creating one;
 *   - emits one `navigates_to` edge per <action app:destination=…>, resolving
 *     ids across nested <navigation> subgraphs and <include app:graph=…>
 *     (a reference to an included graph lands on its startDestination);
 *   - turns every reference it cannot resolve into a coverageWarning — an
 *     unresolved declared edge is a coverage failure, never a silent drop.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  AppEdge,
  AppNode,
  CoverageWarning,
  makeEdgeId,
  makeNodeId,
  screenMatchKey,
} from '../schema';
import { XmlElement, parseXml } from '../extractors/android/xml';
import { ModuleRef } from './manifest-capabilities';

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
const TEST_RES_RE = /\/src\/(test|androidTest|androidtest)\//i;

const DESTINATION_TAGS: Record<string, string> = {
  fragment: 'fragment',
  dialog: 'dialog',
  activity: 'activity',
};

export interface NavigationXmlResult {
  /** Screens newly discovered from nav-graph destinations (existing ones reused). */
  screenNodes: AppNode[];
  /** navigates_to (conf 1) + app_contains for the new screens. */
  edges: AppEdge[];
  warnings: CoverageWarning[];
  stats: { graphFiles: number; destinations: number; navEdges: number; newScreens: number };
}

interface Destination {
  id: string;
  /** fragment | dialog | activity, or 'subgraph' for a nested <navigation>. */
  kind: string;
  /** Destination class FQN (absent on subgraphs). */
  className?: string;
  /** subgraph only: where entering the subgraph lands. */
  startDestinationId?: string;
}

interface ParsedGraph {
  relPath: string;
  /** The root <navigation> element's own android:id (referenced by includers). */
  rootId?: string;
  startDestinationId?: string;
  destinations: Map<string, Destination>;
  actions: Array<{ fromId: string; toId: string }>;
  /** Included graph names (`@navigation/foo` → 'foo'). */
  includes: string[];
  globalActions: number;
}

/**
 * Parse every `res/navigation/*.xml` under `projectRoot` and lift the declared
 * navigation. `existingScreens` is the Screen index built by the earlier passes
 * (manifest activities, compose, layouts) — destinations resolve into it by
 * simple class name before a new Screen is synthesized.
 */
export function detectNavigationXml(
  projectRoot: string,
  modules: ModuleRef[],
  existingScreens: AppNode[]
): NavigationXmlResult {
  const warnings: CoverageWarning[] = [];
  const graphs = new Map<string, ParsedGraph>(); // graph stem → parsed
  let graphFiles = 0;

  for (const abs of findNavigationXml(projectRoot)) {
    const relPath = toPosix(relative(projectRoot, abs));
    let source: string;
    try {
      source = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const root = parseXml(source);
    if (!root || root.tag !== 'navigation') {
      warnings.push({ message: `S3 · 无法解析导航图 XML(根元素应为 <navigation>):${relPath}`, ref: { file: relPath } });
      continue;
    }
    graphFiles++;
    const stem = baseName(relPath).replace(/\.xml$/i, '');
    // A graph stem duplicated across modules keeps the first (sorted) file; the
    // duplicate is reported so an include's target is never silently ambiguous.
    if (graphs.has(stem)) {
      warnings.push({ message: `S3 · 导航图名重复,include 解析取先者:${stem}(${relPath})`, ref: { file: relPath } });
      continue;
    }
    graphs.set(stem, parseGraph(root, relPath));
  }

  // --- resolve + emit ---------------------------------------------------------

  const screenIndex = new Map<string, AppNode>(); // lowercase simple name → Screen
  for (const s of existingScreens) screenIndex.set(s.name.toLowerCase(), s);

  const dirIndex = modules
    .filter((m) => m.dir)
    .map((ref) => ({ dir: ref.dir, ref }))
    .sort((a, b) => b.dir.length - a.dir.length);

  const newScreens = new Map<string, AppNode>();
  const edges = new Map<string, AppEdge>();
  let destinations = 0;
  let navEdges = 0;

  /** Resolve a destination id to its concrete (class-backed) destination. */
  const resolveDest = (
    graph: ParsedGraph,
    id: string,
    visited: Set<string>
  ): { dest: Destination; graph: ParsedGraph } | null => {
    const key = `${graph.relPath}\0${id}`;
    if (visited.has(key)) return null;
    visited.add(key);

    const own = graph.destinations.get(id);
    if (own) {
      if (own.kind !== 'subgraph') return { dest: own, graph };
      return own.startDestinationId ? resolveDest(graph, own.startDestinationId, visited) : null;
    }
    for (const inc of graph.includes) {
      const included = graphs.get(inc);
      if (!included) continue;
      if (included.rootId === id) {
        return included.startDestinationId
          ? resolveDest(included, included.startDestinationId, visited)
          : null;
      }
    }
    return null;
  };

  /** The Screen node for a concrete destination — existing by simple name, else new. */
  const screenFor = (dest: Destination, graph: ParsedGraph): AppNode | null => {
    const className = dest.className;
    if (!className) return null;
    if (className.startsWith('.')) {
      warnings.push({
        message: `S3 · 导航目的地 ${dest.id} 使用相对类名 “${className}”,无法在无 package 上下文时解析`,
        ref: { file: graph.relPath, symbol: className },
      });
      return null;
    }
    const simpleName = className.split('.').pop()!;
    const existing = screenIndex.get(simpleName.toLowerCase());
    if (existing) return existing;

    const matchKey = screenMatchKey(simpleName);
    const node: AppNode = {
      id: makeNodeId('android', 'Screen', matchKey),
      kind: 'Screen',
      matchKey,
      name: simpleName,
      platform: 'android',
      subtype: dest.kind,
      platformRef: { file: graph.relPath, symbol: className },
      provenance: 'manifest', // a nav graph is a declared build artifact
      fidelity: 'source-project',
      confidence: 1,
      attrs: {
        discoveredBy: 'nav-graph-xml',
        className,
        module: attributeModule(graph.relPath, dirIndex)?.name,
      },
    };
    screenIndex.set(simpleName.toLowerCase(), node);
    newScreens.set(node.id, node);

    const owner = attributeModule(graph.relPath, dirIndex);
    if (owner) {
      const cid = makeEdgeId('app_contains', owner.id, node.id);
      if (!edges.has(cid)) {
        edges.set(cid, {
          id: cid,
          kind: 'app_contains',
          from: owner.id,
          to: node.id,
          provenance: 'manifest',
          confidence: 1,
          attrs: { kind: 'screen', via: 'nav-graph-xml' },
        });
      }
    }
    return node;
  };

  for (const stem of [...graphs.keys()].sort()) {
    const graph = graphs.get(stem)!;
    destinations += [...graph.destinations.values()].filter((d) => d.kind !== 'subgraph').length;

    if (graph.globalActions > 0) {
      warnings.push({
        message:
          `S3 · 导航图 ${stem} 有 ${graph.globalActions} 个全局 <action>(无固定源页面),` +
          `未生成 navigates_to 边——跳转目标仍在图中,仅缺出发端归因`,
        ref: { file: graph.relPath },
      });
    }

    for (const action of graph.actions) {
      const from = resolveDest(graph, action.fromId, new Set());
      const to = resolveDest(graph, action.toId, new Set());
      if (!to) {
        warnings.push({
          message: `S3 · 导航图 ${stem} 的 action 目的地 “@id/${action.toId}” 无法解析(本图/子图/include 均未命中)`,
          ref: { file: graph.relPath, symbol: action.toId },
        });
        continue;
      }
      if (!from) continue; // fromId always exists — it's the enclosing destination
      const fromScreen = screenFor(from.dest, from.graph);
      const toScreen = screenFor(to.dest, to.graph);
      if (!fromScreen || !toScreen || fromScreen.id === toScreen.id) continue;

      const eid = makeEdgeId('navigates_to', fromScreen.id, toScreen.id);
      if (!edges.has(eid)) {
        edges.set(eid, {
          id: eid,
          kind: 'navigates_to',
          from: fromScreen.id,
          to: toScreen.id,
          provenance: 'manifest',
          confidence: 1,
          attrs: { via: 'nav-graph-xml', graph: graph.relPath },
        });
        navEdges++;
      }
    }
  }

  return {
    screenNodes: [...newScreens.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)),
    warnings,
    stats: { graphFiles, destinations, navEdges, newScreens: newScreens.size },
  };
}

// =============================================================================
// Parsing
// =============================================================================

function parseGraph(root: XmlElement, relPath: string): ParsedGraph {
  const graph: ParsedGraph = {
    relPath,
    rootId: refId(attr(root, 'id')),
    startDestinationId: refId(attr(root, 'startDestination')),
    destinations: new Map(),
    actions: [],
    includes: [],
    globalActions: 0,
  };
  collectDestinations(root, graph);
  return graph;
}

/** Walk a <navigation> element: destinations, nested subgraphs, includes, actions. */
function collectDestinations(nav: XmlElement, graph: ParsedGraph): void {
  for (const child of nav.children) {
    if (child.tag === 'action') {
      graph.globalActions++; // action directly under <navigation> has no source screen
      continue;
    }
    if (child.tag === 'include') {
      const target = refName(attr(child, 'graph'));
      if (target) graph.includes.push(target);
      continue;
    }
    const id = refId(attr(child, 'id'));
    if (child.tag === 'navigation') {
      // Nested subgraph: addressable by its id, entering lands on its startDestination.
      if (id) {
        graph.destinations.set(id, {
          id,
          kind: 'subgraph',
          startDestinationId: refId(attr(child, 'startDestination')),
        });
      }
      collectDestinations(child, graph);
      continue;
    }
    const kind = DESTINATION_TAGS[child.tag];
    if (!kind || !id) continue;
    graph.destinations.set(id, { id, kind, className: attr(child, 'name') });
    for (const action of child.children) {
      if (action.tag !== 'action') continue;
      const toId = refId(attr(action, 'destination'));
      if (toId) graph.actions.push({ fromId: id, toId });
      // A destination-less action (popUpTo-only back navigation) is not a forward edge.
    }
  }
}

/** Namespaced attribute lookup: `android:id` / `app:destination` / bare `id`. */
function attr(el: XmlElement, local: string): string | undefined {
  return el.attrs[`android:${local}`] ?? el.attrs[`app:${local}`] ?? el.attrs[local];
}

/** `@+id/home` / `@id/home` → `home`. */
function refId(v: string | undefined): string | undefined {
  const m = v === undefined ? null : /^@\+?id\/(.+)$/.exec(v);
  return m?.[1];
}

/** `@navigation/nav_main` → `nav_main`. */
function refName(v: string | undefined): string | undefined {
  const m = v === undefined ? null : /^@navigation\/(.+)$/.exec(v);
  return m?.[1];
}

// =============================================================================
// Filesystem
// =============================================================================

/** Every shippable `res/navigation/*.xml` under `root`, sorted. */
function findNavigationXml(root: string): string[] {
  const out: string[] = [];
  const walkDir = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) walkDir(full);
      } else if (entry.name.endsWith('.xml')) {
        const posix = toPosix(full);
        if (TEST_RES_RE.test(posix)) continue;
        if (/\/res\/navigation\/[^/]+\.xml$/.test(posix)) out.push(full);
      }
    }
  };
  walkDir(root);
  return out.sort();
}

function attributeModule(
  relPath: string,
  dirIndex: Array<{ dir: string; ref: ModuleRef }>
): ModuleRef | null {
  for (const { dir, ref } of dirIndex) {
    if (relPath === dir || relPath.startsWith(`${dir}/`)) return ref;
  }
  return null;
}

function baseName(relPath: string): string {
  return relPath.split('/').pop() ?? relPath;
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}
