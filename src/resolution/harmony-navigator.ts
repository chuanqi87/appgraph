/**
 * `harmony-nav` — HarmonyOS Navigation route synthesis.
 *
 * WHY: HarmonyOS navigation is string-keyed. `NavPathStack.pushPathByName(name)`
 * (1,401 corpus uses, plus 1,713 `pushPath` and 262 `replacePathByName`) carries
 * no reference to the destination — the name→page mapping lives in
 * `route_map.json`. Static extraction therefore breaks at every screen
 * transition, and `codegraph_explore` cannot connect a single page flow in an
 * app with 2,781 `NavPathStack` uses.
 *
 * (The existing `arkui-route` family covers the LEGACY `router.pushUrl({url:
 * 'pages/X'})` form — 19 corpus uses. Different resolution model entirely, so it
 * stays a separate family rather than growing a second strategy inside it.)
 *
 * PRECISION: the route registry is a whitelist. A route token resolves only when
 * it is a literal, or an enum member whose string value is known, AND the result
 * names a registered route. Everything else — `info.url`, `v.routerName`,
 * `page.pageName` (the majority of the 1,144 non-literal call sites) — is
 * dropped, never guessed. This follows the file's precise-or-drop rule; the
 * resulting coverage gap is reported by the AppGraph nav lift, not hidden.
 *
 * COST: gated on `AppScope/` so a non-HarmonyOS project pays one `existsSync`.
 */

import type { Edge, Node } from '../types';
import type { ResolutionContext } from './types';
import {
  buildRouteRegistry,
  type HarmonyRoute,
  type HarmonyRouteRegistry,
} from '../appgraph/extractors/harmony/route-map';
import { loadHarmonyProject } from '../appgraph/extractors/harmony/project';
import { enumMemberStringValue } from '../appgraph/detect/arkts-source';

/** Navigation verbs. Deliberately broad — the registry provides the precision. */
const NAV_CALL_RE =
  /\.(pushPathByName|pushDestinationByName|replacePathByName|popToName|pushPath|pushDestination|replacePath|push|replace)\s*\(/g;

/**
 * Route-name candidates: string literals and `Enum.MEMBER` references. An
 * optional `name:`/`url:` key prefix covers the `RouterModule.push({ url:
 * RouterMap.X })` wrapper every project defines. Global — ALL candidates in the
 * route argument are considered, not just the first (see `routeCandidates`).
 */
const ROUTE_TOKEN_RE =
  /(?:\b(?:name|url|routerName|pageName)\s*:\s*)?(?:'([\w-]+)'|"([\w-]+)"|\b([A-Z]\w*)\.([A-Za-z_]\w*))/g;

/** Hard cap on how far a call's argument list is scanned. */
const TOKEN_WINDOW = 240;

/** Most candidates to consider in one route argument (ternary chains stay small). */
const MAX_ROUTE_CANDIDATES = 6;

/**
 * The text of the nav call's FIRST argument — the route name.
 *
 * Two bounds, both load-bearing:
 *   - the matching `)`, so a fixed-length window cannot run past the call into
 *     the next statement (`list.push(item)` once picked up a route name from the
 *     following method and invented `addToList → ResultPage`);
 *   - the first top-level `,`, so the trailing `param` / `onPop` / `animated`
 *     arguments are not scanned. Those routinely carry unrelated enum values,
 *     and scanning them could pair a jump with a second, wrong destination.
 */
function routeArgument(content: string, start: number): string {
  const limit = Math.min(content.length, start + TOKEN_WINDOW);
  let depth = 1;
  for (let i = start; i < limit; i++) {
    const c = content[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (--depth === 0) return content.slice(start, i);
    } else if (c === ',' && depth === 1) {
      return content.slice(start, i);
    }
  }
  return content.slice(start, limit);
}

/** One resolved route name plus how it was recovered. */
interface RouteCandidate {
  route: string;
  resolvedBy: 'literal' | 'enum';
}

/**
 * Every route name the argument can yield, in source order.
 *
 * Taking only the FIRST candidate loses real destinations and can pick the wrong
 * token entirely: in `pushPathByName(cardData.type === NewsEnum.Broadcast ?
 * RouterMap.AUDIO_DETAILS : RouterMap.VIDEO_PROGRAM_DETAILS, params)` the first
 * `Ident.MEMBER` is the CONDITION's enum, so that site produced no edge at all
 * while both branches were real destinations. Collecting all candidates and letting
 * the route registry decide keeps precision (a non-route token simply misses)
 * while recovering every branch.
 */
function routeCandidates(argument: string, enumIndex: Map<string, string>): RouteCandidate[] {
  const out: RouteCandidate[] = [];
  const seen = new Set<string>();
  ROUTE_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ROUTE_TOKEN_RE.exec(argument)) && out.length < MAX_ROUTE_CANDIDATES) {
    const literal = m[1] ?? m[2];
    let route: string | undefined;
    let resolvedBy: RouteCandidate['resolvedBy'];
    if (literal) {
      route = literal;
      resolvedBy = 'literal';
    } else if (m[3] && m[4]) {
      route = enumIndex.get(`${m[3]}.${m[4]}`);
      resolvedBy = 'enum';
    } else {
      continue;
    }
    if (!route || seen.has(route)) continue;
    seen.add(route);
    out.push({ route, resolvedBy });
  }
  return out;
}

/** `windowStage.loadContent('views/Index')` — Ability → first screen. */
const LOAD_CONTENT_RE = /loadContent\s*\(\s*['"]([\w/]+)['"]/g;

/** Per-enclosing-function cap, matching the other synthesized families. */
const MAX_EDGES_PER_FUNCTION = 8;

export function harmonyNavigatorEdges(ctx: ResolutionContext): Edge[] {
  const root = ctx.getProjectRoot();
  const project = loadHarmonyProject(root);
  if (!project) return []; // not a HarmonyOS project — one existsSync, then out

  const registry = buildRouteRegistry(project);
  if (registry.byName.size === 0) return [];

  const enumIndex = buildEnumStringIndex(ctx);
  const edges: Edge[] = [];
  const seen = new Set<string>();

  for (const file of ctx.getAllFiles()) {
    if (!file.endsWith('.ets')) continue;
    const content = ctx.readFile(file);
    if (!content) continue;
    const interesting =
      content.includes('push') ||
      content.includes('replace') ||
      content.includes('popToName') ||
      content.includes('loadContent');
    if (!interesting) continue;

    const fns = ctx
      .getNodesInFile(file)
      .filter((n) => n.kind === 'method' || n.kind === 'function');
    const perFn = new Map<string, number>();

    collectNavEdges(content, fns, perFn, registry, enumIndex, ctx, edges, seen);
    collectLoadContentEdges(content, file, fns, perFn, project.modules, ctx, edges, seen);
  }

  return edges;
}

function collectNavEdges(
  content: string,
  fns: Node[],
  perFn: Map<string, number>,
  registry: HarmonyRouteRegistry,
  enumIndex: Map<string, string>,
  ctx: ResolutionContext,
  out: Edge[],
  seen: Set<string>
): void {
  NAV_CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NAV_CALL_RE.exec(content))) {
    const verb = m[1]!;
    const argument = routeArgument(content, m.index + m[0].length);
    const candidates = routeCandidates(argument, enumIndex);
    if (candidates.length === 0) continue;

    const line = lineAt(content, m.index);
    const encl = enclosingFn(fns, line);
    if (!encl) continue;

    for (const candidate of candidates) {
      // The registry IS the whitelist: an unknown name is dropped, never guessed.
      // This is also what makes scanning ALL candidates safe — a condition's enum
      // or an unrelated constant simply fails the lookup.
      const route = registry.byName.get(candidate.route);
      if (!route) continue;

      const dest = resolveDestinationStruct(route, ctx);
      if (!dest) continue;

      push(out, seen, perFn, {
        source: encl.id,
        target: dest.id,
        kind: 'calls',
        line,
        provenance: 'heuristic',
        metadata: {
          synthesizedBy: 'harmony-nav',
          route: candidate.route,
          via: verb,
          resolvedBy: candidate.resolvedBy,
          registeredAt: `${route.pageFile}:${dest.startLine}`,
        },
      });
    }
  }
}

/**
 * `windowStage.loadContent('views/Index')` inside an ability — the ONE static
 * link from an app entry to its first screen (82 corpus uses).
 */
function collectLoadContentEdges(
  content: string,
  file: string,
  fns: Node[],
  perFn: Map<string, number>,
  modules: Array<{ dir: string }>,
  ctx: ResolutionContext,
  out: Edge[],
  seen: Set<string>
): void {
  const moduleDir = modules
    .map((m) => m.dir)
    .filter((d) => file === d || file.startsWith(`${d}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (moduleDir === undefined) return;

  LOAD_CONTENT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LOAD_CONTENT_RE.exec(content))) {
    const pagePath = m[1]!;
    // Relative to `<module>/src/main/ets/`, extension omitted.
    const target = `${moduleDir}/src/main/ets/${pagePath}.ets`;
    const structs = ctx.getNodesInFile(target).filter((n) => n.kind === 'struct');
    if (structs.length === 0) continue;
    const dest =
      structs.find((s) => (s.decorators ?? []).includes('Entry')) ??
      (structs.length === 1 ? structs[0] : undefined);
    if (!dest) continue;

    const line = lineAt(content, m.index);
    const encl = enclosingFn(fns, line);
    if (!encl) continue;

    push(out, seen, perFn, {
      source: encl.id,
      target: dest.id,
      kind: 'calls',
      line,
      provenance: 'heuristic',
      metadata: {
        synthesizedBy: 'harmony-nav',
        route: pagePath,
        via: 'loadContent',
        resolvedBy: 'literal',
        registeredAt: `${target}:${dest.startLine}`,
      },
    });
  }
}

/**
 * Resolve a route to its page struct, graph-anchored with two fallbacks.
 *
 * The `buildFunction` link is exact: `@Builder function buildOrderDetailPage() {
 * OrderDetailPage() }` produces a real `calls` edge to the struct, so the
 * destination never has to be guessed from the route or file name (all three
 * routinely differ).
 */
function resolveDestinationStruct(route: HarmonyRoute, ctx: ResolutionContext): Node | null {
  const inFile = ctx.getNodesInFile(route.pageFile);
  const structs = inFile.filter((n) => n.kind === 'struct');
  if (structs.length === 0) return null;
  if (structs.length === 1) return structs[0]!;

  // 1) The @Builder body instantiates the page: `{ OrderDetailPage() }`.
  if (route.buildFunction) {
    const builder = inFile.find(
      (n) => (n.kind === 'function' || n.kind === 'method') && n.name === route.buildFunction
    );
    if (builder) {
      const body = sliceLines(ctx, route.pageFile, builder.startLine, builder.endLine);
      if (body) {
        const named = structs.filter((s) => new RegExp(`\\b${s.name}\\s*\\(`).test(body));
        if (named.length === 1) return named[0]!;
      }
    }
  }

  // 2) The struct named after the file.
  const stem = route.pageFile.split('/').pop()!.replace(/\.ets$/, '');
  return structs.find((s) => s.name === stem) ?? null; // still ambiguous → drop
}

/**
 * `Enum.MEMBER` → its string value, for enums whose members are string literals.
 *
 * Route names reach the call site as enum members far more often than as
 * literals (`RouterMap.PROFILE_HOME`, `PageName.FeedbackHistory`), so without
 * this most navigation stays unresolvable. Keys are simple names because that is
 * what a call site writes; a name whose members disagree across enums is deleted
 * rather than arbitrated.
 */
function buildEnumStringIndex(ctx: ResolutionContext): Map<string, string> {
  const index = new Map<string, string>();
  const conflicted = new Set<string>();

  for (const en of ctx.getNodesByKind('enum')) {
    if (en.language !== 'arkts' && en.language !== 'typescript') continue;
    for (const member of ctx.getNodesInFile(en.filePath)) {
      if (member.kind !== 'enum_member') continue;
      // Members live inside the enum's line span.
      if (member.startLine < en.startLine || member.endLine > en.endLine) continue;

      const source = sliceLines(ctx, member.filePath, member.startLine, member.endLine);
      if (source === null) continue;
      const value = enumMemberStringValue(source);
      if (!value) continue;

      const key = `${en.name}.${member.name}`;
      if (conflicted.has(key)) continue;
      const prev = index.get(key);
      if (prev !== undefined && prev !== value) {
        index.delete(key);
        conflicted.add(key);
      } else {
        index.set(key, value);
      }
    }
  }
  return index;
}

function sliceLines(
  ctx: ResolutionContext,
  filePath: string,
  startLine: number,
  endLine: number
): string | null {
  const lines = ctx.getFileLines?.(filePath) ?? ctx.readFile(filePath)?.split('\n') ?? null;
  if (!lines) return null;
  return lines.slice(startLine - 1, endLine).join('\n');
}

/** The innermost function/method containing `line`. */
function enclosingFn(fns: Node[], line: number): Node | undefined {
  return fns
    .filter((n) => n.startLine <= line && n.endLine >= line)
    .sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0];
}

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

function push(
  out: Edge[],
  seen: Set<string>,
  perFn: Map<string, number>,
  edge: Edge
): void {
  const key = `${edge.source}>${edge.target}`;
  if (seen.has(key)) return;
  const used = perFn.get(edge.source) ?? 0;
  if (used >= MAX_EDGES_PER_FUNCTION) return;
  seen.add(key);
  perFn.set(edge.source, used + 1);
  out.push(edge);
}
