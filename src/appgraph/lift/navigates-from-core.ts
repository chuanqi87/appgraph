/**
 * Navigation lift FROM the core graph (AppGraph A2).
 *
 * The app-semantic navigation edges (Screen → Screen `navigates_to`, Screen →
 * BackgroundComponent `backed_by`) are LIFTED from the deterministic core
 * synthesized edges rather than re-scanned from source:
 *   - compose-route (navigate("home") → route → destination composable) →
 *     navigates_to between the two composables' Screen nodes;
 *   - android-intent (startActivity/startService(Intent(_, X::class.java)) → X) →
 *     navigates_to (Activity target) or backed_by (Service target), from the
 *     enclosing screen's owning class;
 *   - android-fragment (FragmentTransaction .replace/.add / DialogFragment .show)
 *     → navigates_to the target Fragment/Dialog Screen (conf 0.8; nav_graph.xml
 *     manifest edges dedup ahead of it).
 *
 * This is the two-graph payoff: one deterministic derivation, no source double
 * scan. A navigate call one hop behind a screen (a `navigateToX()` helper the
 * screen calls) is followed via the core `calls` edges. Every edge is
 * `provenance:'lifted'` with `attrs.liftedFrom` naming the core synthesizer.
 */

import { AppEdge, AppNode, makeEdgeId } from '../schema';
import { CodeSymbolGraph } from '../graph-reader';
import { isTestPath } from '../detect/shared';
import { Node } from '../../types';

/** Caller-chain traversal bounds: a navigate helper is rarely more than a couple
 *  of hops behind its screen; past that the attribution is app-wide plumbing. */
const CALLER_MAX_DEPTH = 3;
const CALLER_MAX_VISITED = 64;
/** A site attributed to more screens than this is shared chrome, not a flow. */
const SOURCE_SCREEN_CAP = 4;
/** Import-based helper attribution fans wider (every screen consuming the helper). */
const IMPORTER_SCREEN_CAP = 8;

export interface NavFromCoreResult {
  navEdges: AppEdge[];
  stats: { navigatesTo: number; backedBy: number };
}

/**
 * Lift navigates_to / backed_by from the core synthesized edges. `targets` are
 * the app graph's Screen + BackgroundComponent nodes (the nav endpoints).
 */
export function liftNavigatesToFromCore(
  reader: CodeSymbolGraph,
  targets: AppNode[]
): NavFromCoreResult {
  // Index endpoints by every spelling a core node might carry: the node name,
  // the full platform symbol, and its simple tail — a manifest Activity Screen's
  // symbol is the FQN (`com.x.DetailActivity`) while the core class node is the
  // simple name (`DetailActivity`), so the tail is what joins them.
  const screenBySymbol = new Map<string, AppNode>();
  const componentBySymbol = new Map<string, AppNode>();
  const addKey = (map: Map<string, AppNode>, key: string | undefined, node: AppNode): void => {
    if (key && !map.has(key)) map.set(key, node);
  };
  for (const t of targets) {
    const map = t.kind === 'Screen' ? screenBySymbol : t.kind === 'BackgroundComponent' ? componentBySymbol : null;
    if (!map) continue;
    addKey(map, t.name, t);
    const sym = t.platformRef?.symbol;
    if (sym) {
      addKey(map, sym, t);
      addKey(map, sym.split('.').pop(), t);
    }
  }

  const coreById = new Map(reader.getAllNodes().map((n) => [n.id, n]));
  const allEdges = reader.getAllEdges();

  // route core id → destination composable core nodes (seam-2 `references` edges).
  const routeTargets = new Map<string, Node[]>();
  // core node id → its callers (for a screen that calls a navigate helper).
  const callersOf = new Map<string, Node[]>();
  // fn core id → the namespace nodes of files importing it (method-reference
  // callbacks — `onTopicClick = navigator::navigateToTopic` — leave no `calls`
  // edge in the core graph, only the importing file's `imports` edge).
  const importersOf = new Map<string, Node[]>();
  for (const e of allEdges) {
    if (e.kind === 'references') {
      const from = coreById.get(e.source);
      const to = coreById.get(e.target);
      if (from?.kind === 'route' && to) pushInto(routeTargets, e.source, to);
    } else if (e.kind === 'calls') {
      const from = coreById.get(e.source);
      if (from) pushInto(callersOf, e.target, from);
    } else if (e.kind === 'imports') {
      const from = coreById.get(e.source);
      if (from) pushInto(importersOf, e.target, from);
    }
  }

  // classes/structs by file, for owning-class resolution of an intent's caller.
  const classesByFile = new Map<string, Node[]>();
  for (const n of coreById.values()) {
    if (n.kind === 'class' || n.kind === 'struct' || n.kind === 'interface') {
      pushInto(classesByFile, n.filePath, n);
    }
  }
  const owningClassOf = (fn: Node): Node | undefined =>
    (classesByFile.get(fn.filePath) ?? [])
      .filter((c) => c.startLine <= fn.startLine && c.endLine >= fn.endLine)
      .sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0];

  // route nodes by file, for the entry-sibling rule below.
  const routesByFile = new Map<string, Node[]>();
  for (const n of coreById.values()) {
    if (n.kind === 'route') pushInto(routesByFile, n.filePath, n);
  }

  const screenOf = (node: Node): AppNode | undefined => {
    const direct = screenBySymbol.get(node.name);
    if (direct) return direct;
    const owner = owningClassOf(node);
    return owner ? screenBySymbol.get(owner.name) : undefined;
  };

  /** Screens registered by the route nodes of a file (optionally only those inside
   *  a line span) — the destination composables the routes reference. */
  const routeScreensIn = (filePath: string, span?: { start: number; end: number }): AppNode[] => {
    const out: AppNode[] = [];
    for (const route of routesByFile.get(filePath) ?? []) {
      if (span && (route.startLine < span.start || route.endLine > span.end)) continue;
      for (const dest of routeTargets.get(route.id) ?? []) {
        const s = screenBySymbol.get(dest.name);
        if (s && !out.includes(s)) out.push(s);
      }
    }
    return out;
  };

  /** Entry-sibling rule: a navigate call inside an entry-provider fn (Navigation3's
   *  `fun EntryProviderScope<…>.searchEntry(…) { entry<SearchNavKey> { SearchScreen(…) } }`)
   *  belongs to the screen that fn REGISTERS — the destination of the route node(s)
   *  declared within the fn's own line span. */
  const entrySiblingScreens = (fn: Node): AppNode[] =>
    routeScreensIn(fn.filePath, { start: fn.startLine, end: fn.endLine });

  /** Last-chance attribution for a navigate HELPER invoked only through method
   *  references (`navigator::navigateToTopic`): the core graph records no `calls`
   *  edge, but every consuming file imports the helper — attribute the navigation
   *  to the screens those importing files register. Every link is graph-anchored
   *  (imports edge → file's route nodes → route's destination), no name guessing. */
  const importerScreens = (fn: Node): AppNode[] => {
    const out: AppNode[] = [];
    for (const importer of importersOf.get(fn.id) ?? []) {
      if (importer.filePath === fn.filePath || isTestPath(importer.filePath)) continue;
      for (const s of routeScreensIn(importer.filePath)) {
        if (!out.includes(s)) out.push(s);
      }
    }
    return out.length <= IMPORTER_SCREEN_CAP ? out : [];
  };

  /** The Screen(s) a navigate/intent site is attributed to: the site's own screen,
   *  its owning class's screen, the screen its entry-provider registers, or —
   *  helper/overload indirection — a bounded walk up the `calls` chain (a wrapper
   *  overload or `navigateToX()` helper can sit a couple of hops behind the screen). */
  const sourceScreensFor = (fn: Node): AppNode[] => {
    if (isTestPath(fn.filePath)) return []; // a test driving navigation is not app flow
    const direct = screenBySymbol.get(fn.name);
    if (direct) return [direct];
    const owner = owningClassOf(fn);
    const ownerScreen = owner ? screenBySymbol.get(owner.name) : undefined;
    if (ownerScreen) return [ownerScreen];
    const siblings = entrySiblingScreens(fn);
    if (siblings.length > 0) return siblings;

    // Bounded BFS up the caller chain; a branch stops at the first screen it finds.
    const out: AppNode[] = [];
    const visited = new Set<string>([fn.id]);
    let frontier = [fn];
    for (let depth = 0; depth < CALLER_MAX_DEPTH && frontier.length > 0; depth++) {
      const next: Node[] = [];
      for (const node of frontier) {
        for (const caller of callersOf.get(node.id) ?? []) {
          if (visited.has(caller.id) || visited.size > CALLER_MAX_VISITED) continue;
          visited.add(caller.id);
          if (isTestPath(caller.filePath)) continue;
          const s = screenOf(caller) ?? entrySiblingScreens(caller)[0];
          if (s) {
            if (!out.includes(s)) out.push(s);
          } else {
            next.push(caller);
          }
        }
      }
      frontier = next;
    }
    return out.length <= SOURCE_SCREEN_CAP ? out : [];
  };

  const edgeById = new Map<string, AppEdge>();
  const emit = (kind: 'navigates_to' | 'backed_by', from: AppNode, to: AppNode, liftedFrom: string, confidence: number): void => {
    if (from.id === to.id) return;
    const id = makeEdgeId(kind, from.id, to.id);
    if (edgeById.has(id)) return;
    edgeById.set(id, { id, kind, from: from.id, to: to.id, provenance: 'lifted', confidence, attrs: { liftedFrom } });
  };

  for (const e of reader.getSynthesizedEdges(['compose-route', 'android-intent', 'android-fragment'])) {
    const src = coreById.get(e.source);
    if (!src) continue;

    if (e.synthesizedBy === 'compose-route') {
      const dests = routeTargets.get(e.target) ?? [];
      let fromScreens = sourceScreensFor(src);
      let confidence = 0.85;
      if (fromScreens.length === 0 && !isTestPath(src.filePath)) {
        fromScreens = importerScreens(src); // method-reference-only helper
        confidence = 0.7;
      }
      for (const dest of dests) {
        const toScreen = screenBySymbol.get(dest.name);
        if (!toScreen) continue;
        for (const fromScreen of fromScreens) emit('navigates_to', fromScreen, toScreen, 'compose-route', confidence);
      }
    } else if (e.synthesizedBy === 'android-intent') {
      const targetClass = coreById.get(e.target);
      if (!targetClass) continue;
      const isService = e.metadata.via === 'startService';
      const toNode = isService
        ? componentBySymbol.get(targetClass.name)
        : screenBySymbol.get(targetClass.name);
      if (!toNode) continue;
      for (const fromScreen of sourceScreensFor(src)) {
        if (isService) emit('backed_by', fromScreen, toNode, 'android-intent', 0.85);
        else emit('navigates_to', fromScreen, toNode, 'android-intent', 0.9);
      }
    } else if (e.synthesizedBy === 'android-fragment') {
      // FragmentTransaction / DialogFragment target → its Screen node. Lower
      // confidence (0.8) than a manifest Activity intent — a programmatic
      // fragment swap is a softer nav signal. nav_graph.xml (manifest, conf 1)
      // dedups ahead of this via makeEdgeId (first write wins in emit()).
      const targetClass = coreById.get(e.target);
      if (!targetClass) continue;
      const toScreen = screenBySymbol.get(targetClass.name);
      if (!toScreen) continue;
      for (const fromScreen of sourceScreensFor(src)) {
        emit('navigates_to', fromScreen, toScreen, 'android-fragment', 0.8);
      }
    }
  }

  const navEdges = [...edgeById.values()].sort((a, b) => a.id.localeCompare(b.id));
  return {
    navEdges,
    stats: {
      navigatesTo: navEdges.filter((e) => e.kind === 'navigates_to').length,
      backedBy: navEdges.filter((e) => e.kind === 'backed_by').length,
    },
  };
}

function pushInto<T>(map: Map<string, T[]>, key: string, value: T): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}
