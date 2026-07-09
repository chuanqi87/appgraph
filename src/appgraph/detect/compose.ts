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
    if (!leadingAnnotations(code).includes('Composable')) continue;
    const isScreen = SCREEN_NAME_RE.test(node.name) || NAV_PARAM_RE.test(sanitizeKotlin(code));
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
