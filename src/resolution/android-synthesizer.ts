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

/**
 * `navController.navigate("home")` / `navigate(TopicRoute(…))` / `navigate(TopicRoute)`.
 * `\b` (not `\.`) so the bare call inside a nav-helper extension fn also matches —
 * `fun Navigator.navigateToTopic(id) { navigate(TopicNavKey(id)) }` has no receiver
 * dot. Precision holds: the key must still resolve to exactly one `route` node.
 */
const NAVIGATE_RE = /\bnavigate\s*\(\s*(?:route\s*=\s*)?(?:"([^"]+)"|([A-Z]\w*))/g;

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
    if (!content || !content.includes('navigate(')) continue;
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

// --- seam 3d · android-fragment (FragmentTransaction / DialogFragment) --------

/**
 * Fragment/Dialog navigation targets, INLINE forms only (a cross-statement
 * variable form is dropped — silent beats wrong):
 *   - `.replace(R.id.x, MyFragment())` / `.add(containerId, MyFragment.newInstance())`
 *   - reified KTX `commit { replace<MyFragment>(R.id.x) }`
 *   - `MyDialog().show(fm, tag)` / `MyDialog.newInstance(...).show(fm, tag)`
 *   - string-tag dispatch `loadFragment(MyFragment.TAG)` / `createFragmentInstance(MyFragment.TAG)`
 *     (AntennaPod), where the `.TAG` receiver names the destination Fragment
 *     directly — a dynamic `loadFragment(tag)` has no such receiver and is dropped.
 * The target must be named `*Fragment`/`*Dialog` (so `list.add(0, Foo())` and
 * `builder.show()` don't produce spurious edges) AND resolve to exactly one class.
 */
// `.replace(container, Fragment(…))` — container is an identifier (R.id.x / a var),
// then the fragment class as a constructor / newInstance call.
const FRAGMENT_TXN_RE =
  /\b(?:replace|add)\s*\(\s*[A-Za-z_][\w.]*\s*,\s*([A-Z]\w*)\s*(?:\(|\.newInstance|\.getInstance)/g;
// Reified KTX: `replace<MyFragment>(…)` / `add<MyFragment>(…)`.
const FRAGMENT_KTX_RE = /\b(?:replace|add)\s*<\s*([A-Z]\w*)\s*>/g;
// `MyDialog().show(fm, tag)` / `MyDialog.newInstance(args).show(fm, tag)`.
const DIALOG_SHOW_RE = /\b([A-Z]\w*)\s*(?:\([^;{}\n]*\)|\.newInstance\s*\([^;{}\n]*\))\s*\.show\s*\(/g;
// String-tag dispatch (AntennaPod): a fragment-navigation method whose name
// contains "Fragment" (`loadFragment` / `createFragmentInstance` / `loadChildFragment`)
// invoked with a `XxxFragment.TAG` constant as its first argument — the `.TAG`
// RECEIVER names the target Fragment directly, so no switch/when evaluation is
// needed. A dynamic tag (`loadFragment(tag)`, `getDefaultPage()`) has no
// `XxxFragment.TAG` receiver, so it never matches; `case XxxFragment.TAG:` labels
// and `tag.equals(XxxFragment.TAG)` comparisons lack the `…Fragment…(` method
// shape, so they don't fire either.
const FRAGMENT_TAG_RE = /\b\w*[Ff]ragment\w*\s*\(\s*([A-Z]\w*Fragment)\s*\.\s*TAG\b/g;
// Precision gate: only a `*Fragment` / `*Dialog`-named target is a fragment nav —
// this is what keeps `list.add(0, Foo())` and `builder.show()` from producing a
// spurious edge (mirrors android-structure's SCREEN_FILE_RE naming convention).
const FRAGMENT_NAME_RE = /(?:Fragment|Dialog)$/;

/**
 * FragmentTransaction / DialogFragment navigation → calls edge from the
 * enclosing function to the target Fragment/Dialog class (registered as a Screen
 * downstream). Same discipline as android-intent: inline only, resolve-to-one.
 */
export function androidFragmentEdges(ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();

  for (const file of ctx.getAllFiles()) {
    if (!file.endsWith('.kt') && !file.endsWith('.java')) continue;
    const content = ctx.readFile(file);
    if (!content) continue;
    // Cheap gate: a fragment-txn / dialog-show / tag-load construct must plausibly be here.
    if (
      !content.includes('.show(') &&
      !content.includes('replace') &&
      !content.includes('.add(') &&
      !content.includes('.TAG')
    ) {
      continue;
    }
    const safe = stripCommentsForRegex(content, 'java');
    const fns = ctx.getNodesInFile(file).filter((n) => n.kind === 'method' || n.kind === 'function');

    const scan = (re: RegExp, via: string): void => {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(safe)) !== null) {
        const className = m[1]!;
        if (!FRAGMENT_NAME_RE.test(className)) continue; // not a fragment/dialog by name
        const targets = ctx.getNodesByName(className).filter((n) => n.kind === 'class');
        if (targets.length !== 1) continue; // ambiguous or unresolved — never guess
        const target = targets[0]!;
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
            synthesizedBy: 'android-fragment',
            via,
            registeredAt: `${target.filePath}:${target.startLine}`,
          },
        });
      }
    };
    scan(FRAGMENT_TXN_RE, 'fragment-transaction');
    scan(FRAGMENT_KTX_RE, 'fragment-transaction');
    scan(DIALOG_SHOW_RE, 'dialog-show');
    scan(FRAGMENT_TAG_RE, 'fragment-tag');
  }
  return edges;
}

// --- seam 3c · compose-state (recomposition) ----------------------------------

/** Reactive containers whose write recomposes any collector (the `.value=`/`.update` family). */
const REACTIVE_MARKER =
  /\b(?:MutableStateFlow|StateFlow|MutableLiveData|LiveData|mutableStateOf|MutableState|derivedStateOf|mutableIntStateOf|mutableLongStateOf|mutableFloatStateOf|mutableDoubleStateOf)\b/;
/** A reactive property declared by assignment: `val _s = MutableStateFlow(…)`. */
const REACTIVE_ASSIGN_RE =
  /\b(?:val|var)\s+(\w+)\s*(?::[^=\n]+)?=\s*(?:remember\s*\{\s*)?(?:MutableStateFlow|mutableStateOf|MutableLiveData|derivedStateOf|mutableIntStateOf|mutableLongStateOf|mutableFloatStateOf|mutableDoubleStateOf)\b/g;
/** A reactive property declared by type: `val s: StateFlow<T>`. */
const REACTIVE_TYPED_RE =
  /\b(?:val|var)\s+(\w+)\s*:\s*(?:MutableStateFlow|StateFlow|MutableLiveData|LiveData|MutableState|State)\s*</g;
/** A Compose delegate property: `var count by mutableStateOf(0)` — written as `count = …`. */
const REACTIVE_DELEGATE_RE =
  /\b(?:val|var)\s+(\w+)\s+by\s+(?:remember\s*\{\s*)?(?:mutableStateOf|mutableIntStateOf|mutableLongStateOf|mutableFloatStateOf|mutableDoubleStateOf|derivedStateOf)\b/g;

/** A ViewModel feeding more than this many composables is app-wide routing, not a static pair. */
const COMPOSE_STATE_FANOUT_CAP = 8;

function sliceLines(content: string, startLine: number, endLine: number): string {
  return content.split('\n').slice(startLine - 1, endLine).join('\n');
}

function escapeAlt(names: string[]): string {
  return names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
}

interface Composable {
  node: Node;
  /** Signature header (decl → first `{`), for param-type detection. */
  header: string;
  /** Full source, for `viewModel<T>()` detection. */
  body: string;
}

/**
 * A ViewModel method that WRITES reactive state → every `@Composable` that
 * COLLECTS that ViewModel's state (recomposition — the Compose analog of
 * react-render / arkui-state). Cross-class, so it pairs on the ViewModel TYPE:
 *   - the writer side is assignment-gated on the class's OWN reactive property
 *     names (`_x.value=` / `.update{` / `.postValue(` / `.emit(`), so a read-only
 *     method or a class with no reactive state contributes nothing;
 *   - the collector side is a composable that takes the ViewModel as a parameter
 *     (`vm: FooViewModel`) or obtains it via `viewModel<FooViewModel>()`.
 * A ViewModel with more than the fan-out cap of collectors is skipped (app-wide).
 */
export function composeStateEdges(ctx: ResolutionContext): Edge[] {
  // Precompute every @Composable's source once.
  const composables: Composable[] = [];
  for (const kind of ['function', 'method'] as const) {
    for (const n of ctx.getNodesByKind(kind)) {
      if (!Array.isArray(n.decorators) || !n.decorators.includes('Composable')) continue;
      const content = ctx.readFile(n.filePath);
      if (!content) continue;
      const full = stripCommentsForRegex(sliceLines(content, n.startLine, n.endLine), 'java');
      const braceAt = full.indexOf('{');
      composables.push({ node: n, header: braceAt >= 0 ? full.slice(0, braceAt) : full, body: full });
    }
  }
  if (composables.length === 0) return [];

  const edges: Edge[] = [];
  const seen = new Set<string>();

  for (const cls of ctx.getNodesByKind('class')) {
    if (!cls.filePath.endsWith('.kt')) continue;
    const content = ctx.readFile(cls.filePath);
    if (!content) continue;
    const classSrc = stripCommentsForRegex(sliceLines(content, cls.startLine, cls.endLine), 'java');
    if (!REACTIVE_MARKER.test(classSrc)) continue;

    // Reactive property names owned by this class (backing + delegate).
    const props = new Set<string>();
    for (const re of [REACTIVE_ASSIGN_RE, REACTIVE_TYPED_RE, REACTIVE_DELEGATE_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(classSrc)) !== null) props.add(m[1]!);
    }
    if (props.size === 0) continue;
    const propAlt = escapeAlt([...props]);
    // `_x.value = …` / `.update {(` / `.postValue(` / `.emit(` on one of THIS class's props.
    const writeGate = new RegExp(
      `\\b(?:${propAlt})\\s*\\.\\s*(?:value\\s*=(?!=)|update\\s*[({]|postValue\\s*\\(|emit\\s*\\(|tryEmit\\s*\\()`
    );

    // Collectors of THIS ViewModel: param-typed or viewModel<T>()-obtained.
    const typeName = cls.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const paramRe = new RegExp(`:\\s*${typeName}\\b`);
    const obtainRe = new RegExp(
      `(?:hilt)?[vV]iewModel\\s*<\\s*${typeName}\\b|:\\s*${typeName}\\s*=\\s*(?:hilt)?[vV]iewModel\\s*\\(`
    );
    const collectors = composables.filter(
      (c) => paramRe.test(c.header) || obtainRe.test(c.body)
    );
    if (collectors.length === 0 || collectors.length > COMPOSE_STATE_FANOUT_CAP) continue;

    // Writer methods of this class (same file, within the class line span).
    const methods = ctx
      .getNodesInFile(cls.filePath)
      .filter(
        (n) =>
          n.kind === 'method' &&
          n.id !== cls.id &&
          n.startLine >= cls.startLine &&
          n.endLine <= cls.endLine
      );
    for (const method of methods) {
      const body = stripCommentsForRegex(sliceLines(content, method.startLine, method.endLine), 'java');
      if (!writeGate.test(body)) continue;
      for (const collector of collectors) {
        if (method.id === collector.node.id) continue;
        const key = `${method.id}>${collector.node.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: method.id,
          target: collector.node.id,
          kind: 'calls',
          line: method.startLine,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'compose-state',
            via: cls.name,
            registeredAt: `${collector.node.filePath}:${collector.node.startLine}`,
          },
        });
      }
    }
  }
  return edges;
}
