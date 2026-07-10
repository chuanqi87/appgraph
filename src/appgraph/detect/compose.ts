/**
 * U2 · Compose screens + navigation graph.
 *
 * Turns the app's product structure — its SCREENS and how they navigate — into
 * first-class graph nodes. Phase-2's target side reconstructs @Entry/@Component
 * screens from the community tree-sitter index (verify/target-graph.ts); this is
 * the SOURCE half V1 needs to diff against (a Compose app declares ~1 Activity in
 * its manifest, so screens were invisible before).
 *
 * A Screen is a `@Composable` function that is a navigation destination: named
 * `*Screen`/`*Route`/`*Page`, or taking a nav parameter (NavController / an
 * `onNavigate…`/`onBack…` callback). Navigation edges are recovered from three
 * styles (classic string routes, type-safe `navigateToX`, and Navigation3
 * `entry<XNavKey>{ XScreen(...) }`); unresolved styles surface as coverage
 * warnings, never silent drops.
 */

import {
  AppEdge,
  AppNode,
  CoverageWarning,
  makeEdgeId,
  makeNodeId,
  screenMatchKey,
} from '../schema';
import { Node } from '../../types';
import { leadingAnnotations, sanitizeKotlin } from './kotlin-source';
import { DetectContext, isShippableJvmNode, ReadCode } from './shared';

export interface ComposeResult {
  screenNodes: AppNode[];
  navEdges: AppEdge[];
  containsEdges: AppEdge[];
  warnings: CoverageWarning[];
  stats: { screenCount: number; navEdges: number; unresolvedNav: number };
}

const SCREEN_NAME_RE = /(Screen|Route|Page)$/;
// A composable that TAKES a NavController is a navigation host/destination. We
// deliberately do NOT treat `onBackClick`/`onNavigate` callbacks as a screen
// signal — countless reusable components (toolbars, cards) take those and are
// not screens; name-suffix + NavController param keeps precision high for the
// V1 screen-count diff.
const NAV_PARAM_RE = /:\s*Nav(Host)?Controller\b/;

/**
 * Detect Compose Screen nodes. Navigation edges are no longer scanned from
 * source here — they are lifted from the core graph's compose-route /
 * android-intent synthesized edges by `lift/navigates-from-core.ts` (the
 * two-graph payoff: one deterministic derivation, no source double scan).
 */
export function detectComposeScreens(
  nodes: Node[],
  readCode: ReadCode,
  ctx: DetectContext
): ComposeResult {
  const screens = collectScreens(nodes, readCode, ctx);
  const containsEdges = buildContains(screens);

  return {
    screenNodes: dedupeById(screens.map((s) => s.toNode())).sort((a, b) => a.id.localeCompare(b.id)),
    navEdges: [],
    containsEdges,
    warnings: [],
    stats: { screenCount: countDistinct(screens), navEdges: 0, unresolvedNav: 0 },
  };
}

class Screen {
  constructor(
    readonly name: string,
    readonly matchKey: string,
    readonly id: string,
    readonly moduleId: string | undefined,
    readonly file: string,
    readonly subtype: string,
    /** In-memory only (not serialized) — the source span, for navigation scan. */
    readonly code: string,
    readonly signal: string
  ) {}
  toNode(): AppNode {
    return {
      id: this.id,
      kind: 'Screen',
      matchKey: this.matchKey,
      name: this.name,
      platform: 'android',
      subtype: this.subtype,
      provenance: 'source-static',
      fidelity: 'source-project',
      confidence: this.signal === 'name-suffix' ? 0.9 : 0.7,
      platformRef: { file: this.file, symbol: this.name },
      attrs: { framework: 'compose', signal: this.signal },
    };
  }
}

/** Composable functions that are navigation destinations, deduped by match key. */
function collectScreens(nodes: Node[], readCode: ReadCode, ctx: DetectContext): Screen[] {
  const byMatchKey = new Map<string, Screen>();
  const sorted = [...nodes]
    .filter((n) => n.kind === 'function' && isShippableJvmNode(n))
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const node of sorted) {
    const code = readCode(node);
    if (code === null) continue;
    const annotations = leadingAnnotations(code);
    if (!annotations.includes('Composable')) continue;
    // Previews (`@Preview` and grouped multi-previews like `@DevicePreviews`) are
    // sample renders, and a `private fun` is an internal helper composable —
    // neither is a navigable destination, so excluding both keeps the V1
    // screen-count honest (koler-style layout/preview inflation).
    if (annotations.some((a) => /Previews?$/.test(a))) continue;
    const sanitized = sanitizeKotlin(code);
    if (hasPrivateModifier(sanitized)) continue;
    const isScreen = SCREEN_NAME_RE.test(node.name) || NAV_PARAM_RE.test(sanitized);
    if (!isScreen) continue;

    const matchKey = screenMatchKey(node.name);
    if (byMatchKey.has(matchKey)) continue; // first (id-sorted) wins → stable
    const id = makeNodeId('android', 'Screen', matchKey);
    const signal = SCREEN_NAME_RE.test(node.name) ? 'name-suffix' : 'nav-controller-param';
    byMatchKey.set(
      matchKey,
      new Screen(node.name, matchKey, id, ctx.nodeToModuleId.get(node.id), node.filePath, 'compose', code, signal)
    );
  }
  return [...byMatchKey.values()];
}

/**
 * True when the function carries a `private` visibility modifier. Scans the
 * header before `fun` at bracket-depth 0 so a `private` appearing inside an
 * annotation argument (e.g. `@RequiresPermission(...)`) is never mistaken for the
 * declaration's own visibility. Operates on sanitized source.
 */
function hasPrivateModifier(sanitized: string): boolean {
  const funIdx = /\bfun\b/.exec(sanitized)?.index ?? -1;
  if (funIdx === -1) return false;
  const header = sanitized.slice(0, funIdx);
  let depth = 0;
  const tokens = /[A-Za-z_]\w*|[()<>[\]{}]/g;
  let t: RegExpExecArray | null;
  while ((t = tokens.exec(header)) !== null) {
    const tok = t[0];
    if (tok === '(' || tok === '<' || tok === '[' || tok === '{') depth++;
    else if (tok === ')' || tok === '>' || tok === ']' || tok === '}') depth--;
    else if (depth === 0 && tok === 'private') return true;
  }
  return false;
}

/** ArchModule → Screen containment (attribute each screen to its owning module). */
function buildContains(screens: Screen[]): AppEdge[] {
  const edgeById = new Map<string, AppEdge>();
  for (const s of screens) {
    if (!s.moduleId) continue;
    const id = makeEdgeId('app_contains', s.moduleId, s.id);
    if (!edgeById.has(id)) {
      edgeById.set(id, {
        id,
        kind: 'app_contains',
        from: s.moduleId,
        to: s.id,
        provenance: 'source-static',
        confidence: 0.8,
        attrs: { kind: 'screen' },
      });
    }
  }
  return [...edgeById.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function dedupeById(nodes: AppNode[]): AppNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return [...byId.values()];
}

function countDistinct(screens: Screen[]): number {
  return new Set(screens.map((s) => s.id)).size;
}

// --- Circuit screens (Slack Circuit) ------------------------------------------

/** `@CircuitInject(XxxScreen::class, AppScope::class)` — the first `::class` arg. */
const CIRCUIT_INJECT_RE = /@CircuitInject\s*\(\s*([A-Z]\w*)\s*::\s*class/g;

export interface CircuitResult {
  screenNodes: AppNode[];
  containsEdges: AppEdge[];
  stats: { screenCount: number };
}

/**
 * Detect Slack Circuit Screen nodes. A Circuit screen is the `class`/`object`
 * that IS the navigation key — a `… : Screen` (the marker interface) — surfaced
 * by two independent, precise signals:
 *   - the class declares `: Screen` (supertype), OR
 *   - a `@CircuitInject(XxxScreen::class, …)` names it (its UI/presenter wiring).
 * Both key on the class NAME, which is exactly what `goTo(XxxScreen)` targets, so
 * the `circuit-nav` lift connects navigation to these nodes. Circuit renders
 * Compose, so screens carry `subtype: 'compose'` with `attrs.framework: 'circuit'`.
 */
export function detectCircuitScreens(
  nodes: Node[],
  readCode: ReadCode,
  ctx: DetectContext
): CircuitResult {
  const classByName = new Map<string, Node[]>();
  for (const n of nodes) {
    if (n.kind === 'class' && isShippableJvmNode(n)) {
      const arr = classByName.get(n.name);
      if (arr) arr.push(n);
      else classByName.set(n.name, [n]);
    }
  }

  // signal → the strongest signal seen for each screen class node.
  const signalByNode = new Map<string, { node: Node; signal: 'circuit-inject' | 'circuit-screen' }>();
  const mark = (node: Node, signal: 'circuit-inject' | 'circuit-screen'): void => {
    const prev = signalByNode.get(node.id);
    // circuit-inject (explicit UI wiring) outranks a bare supertype match.
    if (!prev || (signal === 'circuit-inject' && prev.signal !== 'circuit-inject')) {
      signalByNode.set(node.id, { node, signal });
    }
  };

  // A class name resolving to exactly one shippable class node — never guess.
  const resolveOne = (name: string): Node | undefined => {
    const arr = classByName.get(name);
    return arr && arr.length === 1 ? arr[0] : undefined;
  };

  const sorted = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  for (const node of sorted) {
    if (!isShippableJvmNode(node)) continue;
    const code = readCode(node);
    if (code === null) continue;

    // Signal A · supertype `: Screen` on a class/object declaration.
    if (node.kind === 'class' && declaresScreenSupertype(code)) mark(node, 'circuit-screen');

    // Signal B · `@CircuitInject(XxxScreen::class, …)` on any declaration.
    if (code.includes('@CircuitInject')) {
      CIRCUIT_INJECT_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CIRCUIT_INJECT_RE.exec(code)) !== null) {
        const target = resolveOne(m[1]!);
        if (target) mark(target, 'circuit-inject');
      }
    }
  }

  const byMatchKey = new Map<string, AppNode>();
  const containsEdges = new Map<string, AppEdge>();
  for (const { node, signal } of signalByNode.values()) {
    const matchKey = screenMatchKey(node.name);
    if (byMatchKey.has(matchKey)) continue; // id-sorted iteration → stable winner
    const id = makeNodeId('android', 'Screen', matchKey);
    byMatchKey.set(matchKey, {
      id,
      kind: 'Screen',
      matchKey,
      name: node.name,
      platform: 'android',
      subtype: 'compose',
      provenance: 'source-static',
      fidelity: 'source-project',
      confidence: signal === 'circuit-inject' ? 0.9 : 0.8,
      platformRef: { file: node.filePath, symbol: node.name },
      attrs: { framework: 'circuit', signal },
    });
    const moduleId = ctx.nodeToModuleId.get(node.id);
    if (moduleId) {
      const edgeId = makeEdgeId('app_contains', moduleId, id);
      if (!containsEdges.has(edgeId)) {
        containsEdges.set(edgeId, {
          id: edgeId,
          kind: 'app_contains',
          from: moduleId,
          to: id,
          provenance: 'source-static',
          confidence: 0.8,
          attrs: { kind: 'screen' },
        });
      }
    }
  }

  return {
    screenNodes: [...byMatchKey.values()].sort((a, b) => a.id.localeCompare(b.id)),
    containsEdges: [...containsEdges.values()].sort((a, b) => a.id.localeCompare(b.id)),
    stats: { screenCount: byMatchKey.size },
  };
}

/**
 * True when a class/object declaration lists the Circuit `Screen` marker among
 * its supertypes. Strips the primary constructor `(…)` first so a `Screen`-typed
 * constructor/entry PARAMETER (`class DrawerScreen(val screen: Screen)`,
 * `enum class C(val screen: Screen)`) is never mistaken for a supertype.
 */
function declaresScreenSupertype(code: string): boolean {
  const sanitized = sanitizeKotlin(code);
  let paren = 0;
  let angle = 0;
  let header = sanitized;
  for (let i = 0; i < sanitized.length; i++) {
    const ch = sanitized[i]!;
    if (ch === '(') paren++;
    else if (ch === ')') paren--;
    else if (ch === '<') angle++;
    else if (ch === '>') angle--;
    else if (ch === '{' && paren === 0 && angle === 0) {
      header = sanitized.slice(0, i);
      break;
    }
  }
  let withoutCtor = '';
  let depth = 0;
  for (const ch of header) {
    if (ch === '(') depth++;
    else if (ch === ')') { if (depth > 0) depth--; }
    else if (depth === 0) withoutCtor += ch;
  }
  const colon = withoutCtor.indexOf(':');
  if (colon === -1) return false;
  return /(?:^|[\s,])Screen\b/.test(withoutCtor.slice(colon + 1));
}
