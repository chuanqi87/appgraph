/**
 * Slack Circuit navigation synthesis (AppGraph seam 3e).
 *
 * Circuit routes through APIs none of the platform navigation passes see: a
 * screen is a `class`/`object … : Screen` (the marker interface), its UI/presenter
 * is wired by `@CircuitInject(XxxScreen::class, …)`, and navigation is
 * `navigator.goTo(XxxScreen(args))` / `goTo(XxxScreen)`. Static extraction leaves
 * every Circuit app's navigation graph EMPTY (CatchUp: 0 nav edges) even though
 * both endpoints are statically recoverable.
 *
 * This pass closes the `goTo` hole the same way android-intent / compose-route do:
 * a `calls` heuristic edge from the enclosing function to the target `Screen`
 * class, which the AppGraph lift (`liftNavigatesToFromCore`, `circuit-nav` branch)
 * turns into a Screen→Screen `navigates_to`. Two precision gates keep it honest:
 *   1. the `goTo` argument must be a PascalCase constructor/object reference that
 *      resolves to exactly ONE class (a dynamic `goTo(event.screen)` is dropped);
 *   2. that class must itself declare `: Screen` — so a same-named non-screen
 *      class never produces a spurious edge (silent beats wrong).
 */

import type { Edge, Node } from '../../types';
import type { ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

/** `navigator.goTo(XxxScreen(…))` / `goTo(XxxScreen)` — the first PascalCase arg. */
const GO_TO_RE = /\bgoTo\s*\(\s*([A-Z]\w*)\b/g;

/** Smallest function/method node whose line range covers `line` (1-based). */
function enclosingFn(fns: Node[], line: number): Node | undefined {
  return fns
    .filter((n) => n.startLine <= line && n.endLine >= line)
    .sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0];
}

/**
 * True when a class/object declaration lists the Circuit `Screen` marker among
 * its supertypes. Works on the declaration header (decl → class body `{`): the
 * primary-constructor `(…)` is stripped first so a `Screen`-typed CONSTRUCTOR
 * PARAMETER (`class DrawerScreen(val screen: Screen)`) is never mistaken for a
 * supertype, and a `Screen`-typed enum-entry parameter is excluded the same way.
 */
export function declaresCircuitScreen(classSource: string): boolean {
  const header = classHeader(classSource);
  const withoutCtor = stripBalancedParens(header);
  const colon = withoutCtor.indexOf(':');
  if (colon === -1) return false;
  return /(?:^|[\s,])Screen\b/.test(withoutCtor.slice(colon + 1));
}

/** Declaration header: everything up to the class body `{` at paren/angle depth 0. */
function classHeader(src: string): string {
  let paren = 0;
  let angle = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '(') paren++;
    else if (ch === ')') paren--;
    else if (ch === '<') angle++;
    else if (ch === '>') angle--;
    else if (ch === '{' && paren === 0 && angle === 0) return src.slice(0, i);
  }
  return src;
}

/** Remove every balanced `(…)` group (drops the primary constructor / entry args). */
function stripBalancedParens(s: string): string {
  let out = '';
  let depth = 0;
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') { if (depth > 0) depth--; }
    else if (depth === 0) out += ch;
  }
  return out;
}

/**
 * `navigator.goTo(XxxScreen)` → `calls` edge from the enclosing function to the
 * target `Screen` class. Same discipline as android-intent: resolve-to-one, and
 * the target must declare `: Screen` (so `goTo` on a non-Circuit API, or a
 * name collision, never fabricates a navigation edge).
 */
export function circuitNavEdges(ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  // Cache per target class: does it declare `: Screen`? (many goTo sites share one.)
  const isScreenClass = new Map<string, boolean>();
  const screenGate = (target: Node): boolean => {
    const cached = isScreenClass.get(target.id);
    if (cached !== undefined) return cached;
    const content = ctx.readFile(target.filePath);
    const src = content
      ? content.split('\n').slice(target.startLine - 1, target.endLine).join('\n')
      : '';
    const ok = src.length > 0 && declaresCircuitScreen(src);
    isScreenClass.set(target.id, ok);
    return ok;
  };

  for (const file of ctx.getAllFiles()) {
    if (!file.endsWith('.kt')) continue;
    const content = ctx.readFile(file);
    if (!content || !content.includes('goTo')) continue;
    const safe = stripCommentsForRegex(content, 'java');
    const fns = ctx.getNodesInFile(file).filter((n) => n.kind === 'method' || n.kind === 'function');

    GO_TO_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = GO_TO_RE.exec(safe)) !== null) {
      const className = m[1]!;
      const targets = ctx.getNodesByName(className).filter((n) => n.kind === 'class');
      if (targets.length !== 1) continue; // ambiguous or unresolved — never guess
      const target = targets[0]!;
      if (!screenGate(target)) continue; // not a Circuit Screen — drop
      const line = safe.slice(0, m.index).split('\n').length;
      const encl = enclosingFn(fns, line);
      if (!encl || encl.id === target.id) continue;
      const key = `${encl.id}>${target.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: encl.id,
        target: target.id,
        kind: 'calls',
        line,
        provenance: 'heuristic',
        metadata: {
          synthesizedBy: 'circuit-nav',
          event: className,
          registeredAt: `${target.filePath}:${target.startLine}`,
        },
      });
    }
  }
  return edges;
}
