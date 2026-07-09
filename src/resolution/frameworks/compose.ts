/**
 * Jetpack Compose Navigation resolver (AppGraph seam 2).
 *
 * Turns a `NavHost` DSL into `route` nodes + `references` edges route → the
 * destination composable, exactly like the Express/NestJS route→handler
 * precedent. Covers every destination form in one pass — string routes
 * (`composable("home") { HomeScreen() }`), type-safe routes
 * (`composable<HomeRoute> { HomeScreen() }`, what nowinandroid uses), `dialog(...)`,
 * and Navigation3 `entry<HomeKey> { HomeScreen() }`. Covering only strings would
 * leave every type-safe / Nav3 graph a half bridge, so all are mandatory here.
 */

import { Node, Language } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

/** Max destination composables linked per route lambda (guards against a god-lambda). */
const ROUTE_TARGET_CAP = 12;

const DEST_KEYWORD = /\b(composable|dialog|entry)\b/g;
/** Composable invocations in a route lambda body — composables are PascalCase. */
const PASCAL_CALL = /\b([A-Z][A-Za-z0-9_]*)\s*\(/g;

function skipWs(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i]!)) i++;
  return i;
}

/**
 * Index just past the delimiter matching the one at `open`, skipping string
 * literals so a bracket inside a string can't throw off the balance.
 */
function matchDelim(s: string, open: number, oc: string, cc: string): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      i++;
      while (i < s.length && s[i] !== q) { if (s[i] === '\\') i++; i++; }
      continue;
    }
    if (ch === oc) depth++;
    else if (ch === cc) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Index of the `>` matching the `<` at `open` (handles nested generics). */
function matchAngle(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '<') depth++;
    else if (s[i] === '>') { depth--; if (depth === 0) return i; }
    else if (s[i] === '{' || s[i] === '(') return -1; // not a type-arg list
  }
  return -1;
}

/** `com.app.HomeRoute` / `HomeRoute` → `HomeRoute`. */
function lastSegment(typeExpr: string): string {
  const base = typeExpr.split('<')[0]!.trim(); // drop any own type params
  const seg = base.split('.').pop() ?? base;
  return seg.trim();
}

interface RouteKey {
  kind: 'path' | 'type';
  value: string;
}

export const composeResolver: FrameworkResolver = {
  name: 'compose',
  languages: ['kotlin'],

  detect(context: ResolutionContext): boolean {
    for (const file of context.getAllFiles()) {
      const base = file.split(/[\\/]/).pop() ?? '';
      if (base === 'build.gradle' || base === 'build.gradle.kts') {
        const c = context.readFile(file);
        if (c && c.includes('androidx.compose')) return true;
      } else if (file.endsWith('.kt')) {
        const c = context.readFile(file);
        if (c && (c.includes('androidx.compose.runtime') || c.includes('androidx.navigation.compose'))) {
          return true;
        }
      }
    }
    return false;
  },

  extract(filePath: string, content: string) {
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    if (!filePath.endsWith('.kt')) return { nodes, references };

    const lang: Language = 'kotlin';
    // Kotlin shares Java's comment syntax (`//`, `/* */`).
    const safe = stripCommentsForRegex(content, 'java');
    const now = Date.now();

    let m: RegExpExecArray | null;
    DEST_KEYWORD.lastIndex = 0;
    while ((m = DEST_KEYWORD.exec(safe)) !== null) {
      let i = skipWs(safe, m.index + m[0].length);

      // Optional type args: composable<HomeRoute>
      let typeKey: string | undefined;
      if (safe[i] === '<') {
        const end = matchAngle(safe, i);
        if (end > i) {
          typeKey = lastSegment(safe.slice(i + 1, end));
          i = skipWs(safe, end + 1);
        }
      }

      // Optional value args: ("home", deepLinks=…) — pull the string route if present.
      let stringRoute: string | undefined;
      if (safe[i] === '(') {
        const end = matchDelim(safe, i, '(', ')');
        if (end <= i) continue;
        const args = safe.slice(i + 1, end);
        const sm = args.match(/^\s*(?:route\s*=\s*)?["']([^"']+)["']/);
        if (sm) stringRoute = sm[1];
        i = skipWs(safe, end + 1);
      }

      const routeKey: RouteKey | null = typeKey
        ? { kind: 'type', value: typeKey }
        : stringRoute
        ? { kind: 'path', value: stringRoute }
        : null;
      if (!routeKey) continue; // e.g. `composable(navController)` — no destination key

      // Trailing lambda holds the destination composable(s).
      if (safe[i] !== '{') continue;
      const bodyEnd = matchDelim(safe, i, '{', '}');
      if (bodyEnd <= i) continue;
      const body = safe.slice(i + 1, bodyEnd);

      const line = safe.slice(0, m.index).split('\n').length;
      const routeNode: Node = {
        id: `route:${filePath}:${line}:${routeKey.kind}:${routeKey.value}`,
        kind: 'route',
        name: routeKey.value,
        qualifiedName: `${filePath}::route:${routeKey.kind}:${routeKey.value}`,
        filePath,
        startLine: line,
        endLine: safe.slice(0, bodyEnd).split('\n').length,
        startColumn: 0,
        endColumn: 0,
        language: lang,
        updatedAt: now,
      };
      nodes.push(routeNode);

      const seen = new Set<string>();
      let cm: RegExpExecArray | null;
      PASCAL_CALL.lastIndex = 0;
      while ((cm = PASCAL_CALL.exec(body)) !== null && seen.size < ROUTE_TARGET_CAP) {
        const name = cm[1]!;
        if (seen.has(name)) continue;
        seen.add(name);
        references.push({
          fromNodeId: routeNode.id,
          referenceName: name,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: lang,
        });
      }
    }

    return { nodes, references };
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Resolve a route→destination reference to the @Composable of that name.
    // Ambiguity (0 or >1 composables of the name) → null: fall through to the
    // normal pipeline rather than guess (arkui's precise-or-drop rule).
    const composables = context
      .getNodesByName(ref.referenceName)
      .filter(
        (n) =>
          (n.kind === 'function' || n.kind === 'method') &&
          Array.isArray(n.decorators) &&
          n.decorators.includes('Composable')
      );
    if (composables.length === 1) {
      return {
        original: ref,
        targetNodeId: composables[0]!.id,
        confidence: 0.9,
        resolvedBy: 'framework',
      };
    }
    return null;
  },
};
