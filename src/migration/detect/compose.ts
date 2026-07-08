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

/** Detect Compose screens and their navigation graph. */
export function detectComposeScreens(
  nodes: Node[],
  readCode: ReadCode,
  ctx: DetectContext
): ComposeResult {
  const screens = collectScreens(nodes, readCode, ctx);
  const { navEdges, warnings, unresolved } = buildNavigation(screens, nodes, readCode);
  const containsEdges = buildContains(screens);

  return {
    screenNodes: dedupeById(screens.map((s) => s.toNode())).sort((a, b) => a.id.localeCompare(b.id)),
    navEdges,
    containsEdges,
    warnings,
    stats: { screenCount: countDistinct(screens), navEdges: navEdges.length, unresolvedNav: unresolved },
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

/** Index screens by full slug AND base slug (name minus the Screen/Route/Page suffix). */
function screenIndex(screens: Screen[]): Map<string, string> {
  const idx = new Map<string, string>();
  for (const s of screens) {
    const full = slugOf(s.name);
    const base = slugOf(s.name.replace(SCREEN_NAME_RE, ''));
    if (!idx.has(full)) idx.set(full, s.id);
    if (base && !idx.has(base)) idx.set(base, s.id);
  }
  return idx;
}

const NAV_TOKEN_RES = [
  /navigateTo([A-Z]\w*)/g, // type-safe: navigator::navigateToTopic
  /navigate\s*\(\s*([A-Z]\w*)NavKey/g, // Navigation3: navigate(TopicNavKey())
  /onNavigateTo([A-Z]\w*)/g, // callback param naming
  /navigate\s*\(\s*"([\w/]+)"/g, // classic string route
];

/**
 * Recover navigation edges. A navigation call is attributed to the screen whose
 * source contains it; Navigation3 entry-provider blocks (`entry<XNavKey>{ … }`)
 * are folded in by mapping the block's bound NavKey to the screen it renders.
 */
function buildNavigation(
  screens: Screen[],
  nodes: Node[],
  readCode: ReadCode
): { navEdges: AppEdge[]; warnings: CoverageWarning[]; unresolved: number } {
  const idx = screenIndex(screens);
  const edgeById = new Map<string, AppEdge>();
  const warnings: CoverageWarning[] = [];
  let unresolved = 0;

  const emit = (fromId: string, targetName: string, file: string): void => {
    const target = idx.get(slugOf(targetName)) ?? idx.get(slugOf(targetName.replace(SCREEN_NAME_RE, '')));
    if (!target || target === fromId) {
      if (!target) unresolved++;
      return;
    }
    const id = makeEdgeId('navigates_to', fromId, target);
    if (!edgeById.has(id)) {
      edgeById.set(id, {
        id,
        kind: 'navigates_to',
        from: fromId,
        to: target,
        provenance: 'source-static',
        confidence: 0.7,
        attrs: { via: 'compose-nav', file },
      });
    }
  };

  // (1) Navigation calls inside a screen's own body.
  for (const s of screens) {
    for (const name of navTargets(s.code)) emit(s.id, name, s.file);
  }

  // (2) Navigation3 entry-provider blocks: `entry<XNavKey>{ … XScreen(...) … navigate… }`.
  const providerFns = [...nodes]
    .filter((n) => (n.kind === 'function' || n.kind === 'method') && isShippableJvmNode(n))
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const node of providerFns) {
    const code = readCode(node);
    if (code === null || !/entry\s*</.test(code)) continue;
    const sanitized = sanitizeKotlin(code);
    const hostId = hostScreenOf(sanitized, idx);
    if (!hostId) continue;
    for (const name of navTargets(code)) emit(hostId, name, node.filePath);
  }

  if (unresolved > 0) {
    warnings.push({
      message: `U2 · ${unresolved} 处导航调用未能解析到已知屏幕(可能是外部/未建屏幕的路由,或未覆盖的导航样式)`,
    });
  }
  return {
    navEdges: [...edgeById.values()].sort((a, b) => a.id.localeCompare(b.id)),
    warnings,
    unresolved,
  };
}

/** All navigation target names referenced in a source span. */
function navTargets(code: string): string[] {
  const sanitized = sanitizeKotlin(code);
  const names: string[] = [];
  for (const re of NAV_TOKEN_RES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sanitized)) !== null) names.push(m[1]!);
  }
  return names;
}

/** The screen an entry block renders — the first `XScreen(`/`XRoute(` call inside it. */
function hostScreenOf(sanitized: string, idx: Map<string, string>): string | undefined {
  const re = /([A-Z]\w*(?:Screen|Route|Page))\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sanitized)) !== null) {
    const id = idx.get(slugOf(m[1]!)) ?? idx.get(slugOf(m[1]!.replace(SCREEN_NAME_RE, '')));
    if (id) return id;
  }
  return undefined;
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

function slugOf(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function dedupeById(nodes: AppNode[]): AppNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return [...byId.values()];
}

function countDistinct(screens: Screen[]): number {
  return new Set(screens.map((s) => s.id)).size;
}
