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
 * The first route-name candidate after a nav call: a string literal, or a
 * `Enum.MEMBER` reference. An optional `name:`/`url:` key prefix covers the
 * `RouterModule.push({ url: RouterMap.X })` wrapper every project defines.
 */
const ROUTE_TOKEN_RE =
  /(?:\b(?:name|url|routerName|pageName)\s*:\s*)?(?:'([\w-]+)'|"([\w-]+)"|\b([A-Z]\w*)\.([A-Za-z_]\w*))/;

/** Hard cap on how far a call's argument list is scanned. */
const TOKEN_WINDOW = 240;

/**
 * The text of THIS call's argument list — from just after `(` to its matching
 * `)`, capped.
 *
 * A fixed-length window instead runs past the closing paren into whatever
 * follows, so `list.push(item)` could pick up a route name from the NEXT
 * statement and invent a jump (`addToList → ResultPage`). Balancing the parens
 * keeps a match inside the call that actually navigates.
 */
function callArguments(content: string, start: number): string {
  const limit = Math.min(content.length, start + TOKEN_WINDOW);
  let depth = 1;
  for (let i = start; i < limit; i++) {
    const c = content[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (--depth === 0) return content.slice(start, i);
    }
  }
  return content.slice(start, limit);
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
    const window = callArguments(content, m.index + m[0].length);
    const token = ROUTE_TOKEN_RE.exec(window);
    if (!token) continue;

    const literal = token[1] ?? token[2];
    let routeName: string | undefined;
    let resolvedBy: 'literal' | 'enum';
    if (literal) {
      routeName = literal;
      resolvedBy = 'literal';
    } else if (token[3] && token[4]) {
      routeName = enumIndex.get(`${token[3]}.${token[4]}`);
      resolvedBy = 'enum';
    } else {
      continue;
    }
    // The registry IS the whitelist: an unknown name is dropped, never guessed.
    if (!routeName) continue;
    const route = registry.byName.get(routeName);
    if (!route) continue;

    const line = lineAt(content, m.index);
    const encl = enclosingFn(fns, line);
    if (!encl) continue;

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
        route: routeName,
        via: verb,
        resolvedBy,
        registeredAt: `${route.pageFile}:${dest.startLine}`,
      },
    });
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
