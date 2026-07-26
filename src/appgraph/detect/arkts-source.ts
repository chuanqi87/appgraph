/**
 * ArkTS source micro-parsers — pure functions over a symbol's source span.
 *
 * The Kotlin/Java analogues are `kotlin-source.ts` / `java-source.ts`. Each
 * function takes text and returns a fact; no I/O, no graph access, so they are
 * directly unit-testable and cheap to call over a memoized span reader.
 *
 * These deliberately do NOT re-parse whole files: the code graph already has the
 * structure (tree-sitter-arkts). They only recover the few literal-level details
 * the graph does not carry — most importantly the STRING VALUE of an enum
 * member, which is what turns `RouterMap.ORDER_DETAIL` into the route name
 * `'OrderDetail'`.
 */

/**
 * The string value of a `NAME = 'value'` enum member, or null.
 *
 * Numeric / computed / template-literal members return null on purpose: only a
 * plain string literal can be matched against a route registry, and a guess is
 * worse than a gap.
 */
export function enumMemberStringValue(memberSource: string): string | null {
  // The node span covers the whole `NAME = 'value'` assignment.
  const m = /=\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/.exec(memberSource);
  return m ? m[2]! : null;
}

/**
 * The root ArkUI container a `build()` method renders, or null.
 *
 * `NavDestination` marks a Navigation-system page — the mainstream page shape
 * (2,693 uses) — which is how a page is told apart from an ordinary reusable
 * component, since both are just `@ComponentV2 struct`.
 */
export function buildRootComponent(structSource: string): string | null {
  // `build(): void {` is legal and common (195 corpus uses; 87 files pair it
  // with NavDestination). Requiring `()` to be followed directly by `{` made
  // every one of those look like "not a page" — and on the target side, which
  // has no route table to fall back on, that meant reporting a whole app's
  // pages as missing.
  const build = /\bbuild\s*\(\s*\)\s*(?::\s*[\w$.<>[\]|\s]+?)?\s*\{/.exec(structSource);
  if (!build) return null;
  const body = structSource.slice(build.index + build[0].length);
  const m = /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*\s*([A-Z][A-Za-z0-9_]*)\s*[({]/.exec(body);
  return m ? m[1]! : null;
}

/**
 * True when the struct's own `build()` renders a `NavDestination`.
 *
 * Scoped to the build body rather than the first component: a page may wrap its
 * root in control flow (`build() { if (this.ready) { NavDestination() … } }`),
 * which is still a page. Scoping to the STRUCT's build (not the whole file) is
 * what keeps a plain reusable component that merely sits next to a page — or
 * nests one inside a `@Builder` — from being counted as one.
 */
export function isNavDestinationPage(structSource: string): boolean {
  const body = buildBody(structSource);
  return body !== null && /\bNavDestination\s*[({]/.test(body);
}

/** The brace-balanced body of the struct's `build()` method, or null. */
export function buildBody(structSource: string): string | null {
  const build = /\bbuild\s*\(\s*\)\s*(?::\s*[\w$.<>[\]|\s]+?)?\s*\{/.exec(structSource);
  if (!build) return null;
  const start = build.index + build[0].length;
  let depth = 1;
  for (let i = start; i < structSource.length; i++) {
    const c = structSource[i];
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return structSource.slice(start, i);
  }
  return structSource.slice(start); // unbalanced (truncated span) — use the rest
}

/**
 * Property names carrying `@Trace` — the observed fields of an `@ObservedV2`
 * class, i.e. the field schema of a HarmonyOS state model.
 */
export function tracedFields(classSource: string): string[] {
  const out = new Set<string>();
  const re = /@Trace\s+(?:(?:public|private|protected|readonly|static)\s+)*([A-Za-z_$][\w$]*)\s*[:?=]/g;
  for (const m of classSource.matchAll(re)) out.add(m[1]!);
  return [...out].sort();
}
