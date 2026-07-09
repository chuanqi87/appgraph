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
 *     enclosing screen's owning class.
 *
 * This is the two-graph payoff: one deterministic derivation, no source double
 * scan. A navigate call one hop behind a screen (a `navigateToX()` helper the
 * screen calls) is followed via the core `calls` edges. Every edge is
 * `provenance:'lifted'` with `attrs.liftedFrom` naming the core synthesizer.
 */

import { AppEdge, AppNode, makeEdgeId } from '../schema';
import { CodeSymbolGraph } from '../graph-reader';
import { Node } from '../../types';

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
  for (const e of allEdges) {
    if (e.kind === 'references') {
      const from = coreById.get(e.source);
      const to = coreById.get(e.target);
      if (from?.kind === 'route' && to) pushInto(routeTargets, e.source, to);
    } else if (e.kind === 'calls') {
      const from = coreById.get(e.source);
      if (from) pushInto(callersOf, e.target, from);
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

  /** The Screen(s) a navigate/intent site is attributed to: the site's own
   *  screen, its owning class's screen, or (helper indirection) its callers'. */
  const sourceScreensFor = (fn: Node): AppNode[] => {
    const direct = screenBySymbol.get(fn.name);
    if (direct) return [direct];
    const owner = owningClassOf(fn);
    const ownerScreen = owner ? screenBySymbol.get(owner.name) : undefined;
    if (ownerScreen) return [ownerScreen];
    const out: AppNode[] = [];
    for (const caller of callersOf.get(fn.id) ?? []) {
      const s = screenBySymbol.get(caller.name) ?? screenOfOwner(caller);
      if (s) out.push(s);
    }
    return out;
    function screenOfOwner(node: Node): AppNode | undefined {
      const oc = owningClassOf(node);
      return oc ? screenBySymbol.get(oc.name) : undefined;
    }
  };

  const edgeById = new Map<string, AppEdge>();
  const emit = (kind: 'navigates_to' | 'backed_by', from: AppNode, to: AppNode, liftedFrom: string, confidence: number): void => {
    if (from.id === to.id) return;
    const id = makeEdgeId(kind, from.id, to.id);
    if (edgeById.has(id)) return;
    edgeById.set(id, { id, kind, from: from.id, to: to.id, provenance: 'lifted', confidence, attrs: { liftedFrom } });
  };

  for (const e of reader.getSynthesizedEdges(['compose-route', 'android-intent'])) {
    const src = coreById.get(e.source);
    if (!src) continue;

    if (e.synthesizedBy === 'compose-route') {
      const dests = routeTargets.get(e.target) ?? [];
      const fromScreens = sourceScreensFor(src);
      for (const dest of dests) {
        const toScreen = screenBySymbol.get(dest.name);
        if (!toScreen) continue;
        for (const fromScreen of fromScreens) emit('navigates_to', fromScreen, toScreen, 'compose-route', 0.85);
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
