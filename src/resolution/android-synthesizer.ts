/**
 * Android dynamic-dispatch synthesis (AppGraph seam 3).
 *
 * Three families of `provenance:'heuristic'` edges that static parsing misses,
 * each an independent whole-graph pass wired into `synthesizeCallbackEdges`
 * alongside the goframe/arkui precedents:
 *
 *   1. android-intent  — `startActivity/startService(Intent(ctx, X::class.java))`
 *      → the target Activity/Service class (the arkui-route analog for Android).
 *   2. compose-route   — `navController.navigate("home" | RouteType(…))` → the
 *      `route` node the compose resolver created (which already links route →
 *      destination composable), so a nav call reaches its screen end-to-end.
 *   3. compose-state   — a ViewModel method that WRITES reactive state
 *      (`_x.value = …`, `.update {`, `.postValue(`) → every `@Composable` that
 *      COLLECTS that ViewModel's state (recomposition — the Compose analog of
 *      react-render / arkui-state).
 *
 * Every family drops on ambiguity (a name resolving to ≠1 target) rather than
 * guess — silent beats wrong.
 */

import type { Edge, Node } from '../types';
import type { ResolutionContext } from './types';
import { stripCommentsForRegex } from './strip-comments';

// --- seam 3a · android-intent -------------------------------------------------

/** Proven inline-intent regexes (mirrors appgraph/lift/android-navigation.ts). */
const NAV_CALL_RE = /\b(?:startActivity|startActivityForResult|startActivities)\s*\(/;
const SERVICE_CALL_RE = /\b(?:startService|startForegroundService|bindService)\s*\(/;
/** `X::class.java` (Kotlin) / `X.class` (Java) — the intent's target class. */
const CLASS_REF_RE = /([A-Za-z_]\w*)(?:::class\.java|\.class)\b/g;

/** Smallest function/method node whose line range covers `line` (1-based). */
function enclosingFn(fns: Node[], line: number): Node | undefined {
  return fns
    .filter((n) => n.startLine <= line && n.endLine >= line)
    .sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0];
}

/**
 * `startActivity/startService(Intent(ctx, X::class.java))` → calls edge from the
 * enclosing function to the target Activity/Service class. Inline form: the
 * class ref shares the call's line, so there is no cross-statement guessing. A
 * class name that resolves to ≠1 class is dropped.
 */
export function androidIntentEdges(ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();

  for (const file of ctx.getAllFiles()) {
    if (!file.endsWith('.kt') && !file.endsWith('.java')) continue;
    const content = ctx.readFile(file);
    if (
      !content ||
      !(content.includes('startActivity') ||
        content.includes('startService') ||
        content.includes('startForegroundService') ||
        content.includes('bindService'))
    ) {
      continue;
    }
    const safe = stripCommentsForRegex(content, 'java'); // Kotlin & Java share comment syntax
    const fns = ctx.getNodesInFile(file).filter((n) => n.kind === 'method' || n.kind === 'function');
    const lines = safe.split('\n');

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li]!;
      const isSvc = SERVICE_CALL_RE.test(line);
      const isNav = NAV_CALL_RE.test(line);
      if (!isNav && !isSvc) continue;

      CLASS_REF_RE.lastIndex = 0;
      let cm: RegExpExecArray | null;
      while ((cm = CLASS_REF_RE.exec(line)) !== null) {
        const className = cm[1]!;
        const targets = ctx.getNodesByName(className).filter((n) => n.kind === 'class');
        if (targets.length !== 1) continue; // ambiguous or unresolved — never guess
        const target = targets[0]!;
        const lineNo = li + 1;
        const encl = enclosingFn(fns, lineNo);
        if (!encl || encl.id === target.id) continue;
        const key = `${encl.id}>${target.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: encl.id,
          target: target.id,
          kind: 'calls',
          line: lineNo,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'android-intent',
            via: isSvc ? 'startService' : 'startActivity',
            registeredAt: `${target.filePath}:${target.startLine}`,
          },
        });
      }
    }
  }
  return edges;
}

// --- seam 3b · compose-route --------------------------------------------------

/** `navController.navigate("home")` / `navigate(TopicRoute(…))` / `navigate(TopicRoute)`. */
const NAVIGATE_RE = /\.navigate\s*\(\s*(?:route\s*=\s*)?(?:"([^"]+)"|([A-Z]\w*))/g;

/**
 * `navController.navigate("home" | RouteType(…))` → calls edge from the enclosing
 * function to the `route` node of that name (created by the compose resolver,
 * which already links the route → its destination composable). A navigate key
 * matching ≠1 route node is dropped.
 */
export function composeRouteEdges(ctx: ResolutionContext): Edge[] {
  const routes = ctx.getNodesByKind('route').filter((r) => r.language === 'kotlin');
  if (routes.length === 0) return [];
  const routesByName = new Map<string, Node[]>();
  for (const r of routes) {
    const arr = routesByName.get(r.name);
    if (arr) arr.push(r);
    else routesByName.set(r.name, [r]);
  }

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const file of ctx.getAllFiles()) {
    if (!file.endsWith('.kt')) continue;
    const content = ctx.readFile(file);
    if (!content || !content.includes('.navigate(')) continue;
    const safe = stripCommentsForRegex(content, 'java');
    const fns = ctx.getNodesInFile(file).filter((n) => n.kind === 'method' || n.kind === 'function');

    NAVIGATE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = NAVIGATE_RE.exec(safe)) !== null) {
      const routeKey = m[1] ?? m[2];
      if (!routeKey) continue;
      const cands = routesByName.get(routeKey);
      if (!cands || cands.length !== 1) continue; // ambiguous or unknown route — drop
      const route = cands[0]!;
      const line = safe.slice(0, m.index).split('\n').length;
      const encl = enclosingFn(fns, line);
      if (!encl || encl.id === route.id) continue;
      const key = `${encl.id}>${route.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: encl.id,
        target: route.id,
        kind: 'calls',
        line,
        provenance: 'heuristic',
        metadata: {
          synthesizedBy: 'compose-route',
          event: routeKey,
          registeredAt: `${route.filePath}:${route.startLine}`,
        },
      });
    }
  }
  return edges;
}
