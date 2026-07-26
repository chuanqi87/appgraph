/**
 * A2 · HarmonyOS navigation lift — Screen→Screen from the code graph.
 *
 * Reads the `harmony-nav` / `arkui-route` edges the core synthesizers produced
 * and lifts them to `navigates_to` between AppGraph nodes. It does NOT re-scan
 * source: navigation has ONE derivation (the synthesizer), so the two graphs can
 * never disagree about where a jump goes.
 *
 * Attribution walks `calls` edges backwards, because the jump is usually not
 * written in the page itself: `OrderListPage` → `OrderVM.openDetail()` →
 * `pushPathByName(...)`. Without the walk every VM-mediated navigation — the
 * majority — would be dropped.
 *
 * Coverage is reported against the ROUTE REGISTRY, the only honest denominator
 * available without re-scanning: a registered route with no inbound jump is a
 * real gap, whether because the name is computed at runtime (`info.url`) or the
 * caller uses a wrapper the synthesizer does not cover.
 */

import { AppEdge, AppNode, CoverageWarning, makeEdgeId } from '../schema';
import { CodeSymbolGraph } from '../graph-reader';
import type { HarmonyRouteRegistry } from '../extractors/harmony/route-map';

/** How many unreached routes to name individually before summarizing. */
const MAX_LISTED_UNREACHED = 20;

export interface HarmonyNavResult {
  navEdges: AppEdge[];
  warnings: CoverageWarning[];
  stats: {
    navigatesTo: number;
    entryEdges: number;
    routesReached: number;
    routesRegistered: number;
  };
}

export function liftHarmonyNavigation(
  reader: CodeSymbolGraph,
  screens: AppNode[],
  entries: AppNode[],
  registry: HarmonyRouteRegistry
): HarmonyNavResult {
  const synth = reader.getSynthesizedEdges(['harmony-nav', 'arkui-route']);
  const warnings: CoverageWarning[] = [];

  if (synth.length === 0) {
    return {
      navEdges: [],
      warnings: emptyNavWarnings(registry),
      stats: {
        navigatesTo: 0,
        entryEdges: 0,
        routesReached: 0,
        routesRegistered: registry.byName.size,
      },
    };
  }

  const nodes = reader.getAllNodes();
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // AppGraph endpoints indexed by the code file they live in — a Screen's
  // `platformRef.file` is the page file, which is where its struct is declared.
  const screenByFile = new Map<string, AppNode>();
  for (const s of screens) {
    const file = s.platformRef?.file;
    if (file) screenByFile.set(file, s);
  }
  const entryByFile = new Map<string, AppNode>();
  for (const e of entries) {
    const file = e.platformRef?.file;
    if (file) entryByFile.set(file, e);
  }

  // Reverse `calls` index for the backwards walk from a jump site to its page.
  const callersOf = new Map<string, string[]>();
  for (const e of reader.getAllEdges()) {
    if (e.kind !== 'calls') continue;
    const bucket = callersOf.get(e.target);
    if (bucket) bucket.push(e.source);
    else callersOf.set(e.target, [e.source]);
  }

  const edgeById = new Map<string, AppEdge>();
  const routesReached = new Set<string>();
  let entryEdges = 0;

  for (const edge of synth) {
    const target = byId.get(edge.target);
    if (!target) continue;
    const to = screenByFile.get(target.filePath);
    if (!to) continue;

    const source = byId.get(edge.source);
    if (!source) continue;

    const route = typeof edge.metadata.route === 'string' ? edge.metadata.route : undefined;
    const via = typeof edge.metadata.via === 'string' ? edge.metadata.via : undefined;
    const resolvedBy =
      typeof edge.metadata.resolvedBy === 'string' ? edge.metadata.resolvedBy : undefined;

    // `loadContent` is the ability→first-screen link, so its origin is an AppEntry.
    const origins =
      via === 'loadContent'
        ? directOrigin(source.filePath, entryByFile)
        : matchOrigins(source, screenByFile, callersOf, byId);

    for (const from of origins) {
      if (from.id === to.id) continue; // self-navigation is not a graph edge
      const id = makeEdgeId('navigates_to', from.id, to.id);
      if (edgeById.has(id)) continue;
      edgeById.set(id, {
        id,
        kind: 'navigates_to',
        from: from.id,
        to: to.id,
        provenance: 'lifted',
        // A literal route name is stronger evidence than an enum back-resolution.
        confidence: resolvedBy === 'literal' ? 0.9 : 0.85,
        attrs: {
          liftedFrom: 'harmony-nav',
          ...(route ? { route } : {}),
          ...(via ? { via } : {}),
          ...(resolvedBy ? { resolvedBy } : {}),
        },
      });
      if (from.kind === 'AppEntry') entryEdges++;
      if (route) routesReached.add(route);
    }
  }

  warnings.push(...coverageWarnings(registry, routesReached));
  // A legacy-router project has an EMPTY registry, so every registry-based check
  // above is vacuously satisfied. Report its weaker coverage explicitly.
  if (registry.byName.size === 0 && registry.stats.legacyPages >= 3 && edgeById.size === 0) {
    warnings.push({
      message:
        `工程未声明 Navigation 路由表,${registry.stats.legacyPages} 个页面走 main_pages.json(legacy router)——` +
        `未解析出任何页面跳转。legacy router 的覆盖弱于 Navigation 体系,勿当作"该应用无跳转"`,
    });
  }

  return {
    navEdges: [...edgeById.values()].sort((a, b) => a.id.localeCompare(b.id)),
    warnings,
    stats: {
      navigatesTo: edgeById.size,
      entryEdges,
      routesReached: routesReached.size,
      routesRegistered: registry.byName.size,
    },
  };
}

/** An ability's `loadContent` is always written in its own file — no walking. */
function directOrigin(file: string, entryByFile: Map<string, AppNode>): AppNode[] {
  const entry = entryByFile.get(file);
  return entry ? [entry] : [];
}

/**
 * The Screen(s) a jump site belongs to.
 *
 * Direct hit when the jump is written in the page file itself; otherwise walk
 * `calls` backwards from THE JUMPING FUNCTION — the `Page → VM.method() →
 * pushPathByName` shape.
 *
 * Walking from the jumping function (not from its file) is the whole point. A
 * shared helper file typically holds several unrelated entry points — e.g. a
 * `LoginUtils` with both `open()` (shows a sheet, no navigation) and
 * `jumpLoginPage()` (navigates). Seeding the walk with "everyone who calls
 * anything in this file" attributes the jump to every caller of `open()` too,
 * turning one real edge into a star of fabricated ones: measured on the corpus,
 * 36% of ComprehensiveNews's and 31% of ComprehensiveTool's `navigates_to`
 * edges existed only because of that, all at confidence 0.85 — confidently
 * wrong, which is worse than missing.
 */
function matchOrigins(
  site: { id: string; filePath: string },
  screenByFile: Map<string, AppNode>,
  callersOf: Map<string, string[]>,
  byId: Map<string, { id: string; filePath: string }>
): AppNode[] {
  const direct = screenByFile.get(site.filePath);
  if (direct) return [direct];

  // Backwards walk, depth-capped: a jump reached through more than a couple of
  // hops is no longer confidently "this page navigates there".
  const out = new Map<string, AppNode>();
  // Per-NODE visited set: marking a whole FILE visited would stop the walk from
  // exploring that file's other callers, making the result depend on the order
  // symbols happen to come back from the index.
  const seen = new Set<string>([site.id]);
  let frontier = [...(callersOf.get(site.id) ?? [])];

  for (let depth = 0; depth < 3 && frontier.length > 0 && out.size === 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      const node = byId.get(id);
      if (!node) continue;
      const screen = screenByFile.get(node.filePath);
      if (screen) out.set(screen.id, screen);
      else next.push(...(callersOf.get(id) ?? []));
    }
    frontier = next;
  }
  return [...out.values()];
}

/**
 * Warnings for a project where the lift produced nothing at all.
 *
 * The legacy-router case matters as much as the Navigation one: a project whose
 * pages are all declared in `main_pages.json` has an EMPTY route registry, so
 * every registry-based check below is vacuously satisfied. Without this branch
 * such a project reports zero screens-to-screen navigation and zero warnings —
 * indistinguishable from an app that genuinely has no navigation.
 */
function emptyNavWarnings(registry: HarmonyRouteRegistry): CoverageWarning[] {
  if (registry.byName.size >= 5) {
    return [
      {
        message:
          `工程注册了 ${registry.byName.size} 条 Navigation 路由,但核心图中没有任何 harmony-nav 合成边——` +
          `导航图为空,页面跳转关系不可依赖。若 .codegraph 索引由旧版本构建,请用当前版本重跑 codegraph index;` +
          `若索引已是最新,则该工程的路由名可能全部来自运行期数据(如 info.url / page.pageName),静态不可解析`,
      },
    ];
  }

  const legacyPages = registry.stats.legacyPages;
  if (registry.byName.size === 0 && legacyPages >= 3) {
    return [
      {
        message:
          `工程未声明 Navigation 路由表,${legacyPages} 个页面走 main_pages.json(legacy router)——` +
          `导航图为空。legacy router 的跳转覆盖弱于 Navigation 体系,页面跳转关系不完整,勿当作"该应用无跳转"`,
      },
    ];
  }
  return [];
}

/**
 * Coverage against the route registry.
 *
 * The registry is the honest denominator: every entry is a page the project
 * declared reachable, so one with no inbound jump is a real hole in the
 * navigation graph — never presented as "this page just has no callers".
 */
function coverageWarnings(
  registry: HarmonyRouteRegistry,
  reached: Set<string>
): CoverageWarning[] {
  const registered = registry.byName.size;
  if (registered === 0) return [];

  const out: CoverageWarning[] = [];
  const unreached = [...registry.byName.keys()].filter((n) => !reached.has(n)).sort();

  if (registered >= 5 && reached.size === 0) {
    out.push({
      message:
        `${registered} 条注册路由无一能被静态跳转指向——导航图为空,` +
        `页面跳转关系不可依赖(路由名可能全部来自运行期数据)`,
    });
    return out;
  }

  if (registered >= 10 && reached.size < registered * 0.4) {
    const pct = Math.round((reached.size / registered) * 100);
    out.push({
      message:
        `${registered} 条注册路由中只有 ${reached.size} 条(${pct}%)能被静态跳转指向——` +
        `其余路由名来自运行期数据或未覆盖的跳转封装,页面跳转关系不完整`,
    });
  }

  for (const name of unreached.slice(0, MAX_LISTED_UNREACHED)) {
    const route = registry.byName.get(name)!;
    out.push({
      message: `路由 ${name}(${route.pageFile}) 已注册但无任何静态跳转来源`,
      ref: { file: route.sourceFile, symbol: name },
    });
  }
  if (unreached.length > MAX_LISTED_UNREACHED) {
    out.push({
      message: `另有 ${unreached.length - MAX_LISTED_UNREACHED} 条已注册路由无静态跳转来源(未逐条列出)`,
    });
  }
  return out;
}
