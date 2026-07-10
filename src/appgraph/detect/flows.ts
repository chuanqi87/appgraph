/**
 * U5 · async / reactive data flow (lightweight).
 *
 * Kotlin apps push UI state through `StateFlow`/`Flow`/`LiveData`; older Java
 * apps use RxJava (`Observable`/`Single`/`Flowable`/…). The ArkTS equivalent of
 * both is `@State` + an emitter, so the LLM needs to know which reactive streams
 * a module EXPOSES and where they are COLLECTED. This does not attempt a full
 * def-use analysis (that is codegraph/ArkAnalyzer's job) — it records the
 * exposure/collection contract as per-module facts that anchor the translation.
 *
 * Exposure is language-shaped: Kotlin declares `val x: Flow<T>` / `fun x(): Flow<T>`
 * (type AFTER the name); Java declares `Single<T> x(...)` / `Observable<T> x`
 * (type BEFORE the name). Both are recovered here.
 */

import { CoverageWarning } from '../schema';
import { Node } from '../../types';
import { matchBracket, sanitizeKotlin } from './kotlin-source';
import { DetectContext, isShippableJvmNode, ReadCode } from './shared';

/** One exposed reactive stream (name + generic element type + stream kind). */
interface ExposedState {
  name: string;
  type: string;
  flowKind: string;
}

/** Reactive-flow facts for one ArchModule (attached to its attrs). */
export interface FlowFacts {
  /** Exposed reactive properties (name + flow kind). */
  exposedStates: ExposedState[];
  /** Count of collection sites (`collectAsState`, `.collect{}`, `.subscribe(`). */
  collectPoints: number;
}

export interface FlowResult {
  flowsByModule: Map<string, FlowFacts>;
  warnings: CoverageWarning[];
  stats: { exposedStates: number; collectPoints: number; modulesWithFlow: number };
}

// The reactive stream-type vocabulary (Kotlin Flow-family + RxJava), longest
// names first so an alternation matches `MutableStateFlow` whole, not `Flow`.
// `Completable`/`Disposable` carry no element type and are intentionally omitted
// (they need no `<…>` and are disposal plumbing, not migratable state).
const REACTIVE_ALT =
  'MutableStateFlow|MutableSharedFlow|MutableLiveData|ConnectableObservable|BehaviorSubject|PublishSubject|ReplaySubject|StateFlow|SharedFlow|LiveData|Flowable|Observable|Single|Maybe|Subject|Flow';

// The type argument is always captured by a BALANCED angle-bracket scan
// (matchBracket) so a nested generic like `StateFlow<Set<NavKey>>` is preserved
// whole — a non-nesting `<([^>]*)>` truncates it at the first `>`.
const KOTLIN_FIELD_RE = new RegExp(`\\b(?:val|var)\\s+(\\w+)\\s*:\\s*(${REACTIVE_ALT})\\s*<`, 'g');
const KOTLIN_RETURN_RE = new RegExp(`\\)\\s*:\\s*(${REACTIVE_ALT})\\s*<`, 'g');
const JAVA_TYPE_RE = new RegExp(`\\b(${REACTIVE_ALT})\\s*<`, 'g');
const COLLECT_RE = /collectAsStateWithLifecycle|collectAsState|observeAsState|\.collect\s*[{(]|\.subscribe\s*\(/g;

/** Detect reactive exposure/collection points, aggregated per module. */
export function detectFlows(nodes: Node[], readCode: ReadCode, ctx: DetectContext): FlowResult {
  const byModule = new Map<string, FlowFacts>();
  let exposedTotal = 0;
  let collectTotal = 0;

  const factsFor = (moduleId: string): FlowFacts => {
    let f = byModule.get(moduleId);
    if (!f) {
      f = { exposedStates: [], collectPoints: 0 };
      byModule.set(moduleId, f);
    }
    return f;
  };

  const sorted = [...nodes]
    .filter((n) => (n.kind === 'class' || n.kind === 'function' || n.kind === 'method') && isShippableJvmNode(n))
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const node of sorted) {
    const moduleId = ctx.nodeToModuleId.get(node.id);
    if (!moduleId) continue;
    const code = readCode(node);
    if (code === null) continue;
    const sanitized = sanitizeKotlin(code);

    const exposures =
      node.language === 'java' ? javaExposures(sanitized, node) : kotlinExposures(sanitized, node);
    if (exposures.length > 0) {
      const f = factsFor(moduleId);
      for (const e of exposures) {
        if (!f.exposedStates.some((s) => s.name === e.name)) {
          f.exposedStates.push(e);
          exposedTotal++;
        }
      }
    }

    COLLECT_RE.lastIndex = 0;
    let collects = 0;
    while (COLLECT_RE.exec(sanitized) !== null) collects++;
    if (collects > 0) {
      factsFor(moduleId).collectPoints += collects;
      collectTotal += collects;
    }
  }

  // Determinism: sort exposed states within each module.
  for (const [moduleId, f] of byModule) {
    byModule.set(moduleId, {
      exposedStates: [...f.exposedStates].sort((a, b) => a.name.localeCompare(b.name)),
      collectPoints: f.collectPoints,
    });
  }

  return {
    flowsByModule: byModule,
    warnings: [],
    stats: { exposedStates: exposedTotal, collectPoints: collectTotal, modulesWithFlow: byModule.size },
  };
}

/**
 * Kotlin exposures: `val/var name: Type<…>` properties, plus a function's
 * `): Type<…>` return type (attributed to the function/method node's own name —
 * a repository `fun observeItems(): Flow<List<Item>>` is an exposed stream).
 */
function kotlinExposures(sanitized: string, node: Node): ExposedState[] {
  const out: ExposedState[] = [];
  scanBalanced(KOTLIN_FIELD_RE, sanitized, (m, type) => {
    out.push({ name: m[1]!, flowKind: m[2]!, type });
  });
  if (node.kind === 'function' || node.kind === 'method') {
    // The FIRST `): Type<…>` is this node's own return type; use its symbol name.
    KOTLIN_RETURN_RE.lastIndex = 0;
    const m = KOTLIN_RETURN_RE.exec(sanitized);
    if (m) {
      const close = matchBracket(sanitized, KOTLIN_RETURN_RE.lastIndex - 1);
      if (close !== -1) {
        out.push({ name: node.name, flowKind: m[1]!, type: sanitized.slice(KOTLIN_RETURN_RE.lastIndex, close).trim() });
      }
    }
  }
  return out;
}

/**
 * Java exposures: `Type<…> name` where the name is a method (`name(`) or a field
 * (`name;`/`name =`). This is the RxJava shape — `public Single<List<X>> search(…)`
 * / `Observable<T> events` — where the reactive type precedes the identifier.
 *
 * Only matches at the class/method MEMBER level are exposures: a match inside a
 * method body (a local `Single<Y> x = …`) sits one brace deeper and is skipped,
 * so internal reactive plumbing is never mistaken for exposed surface.
 */
function javaExposures(sanitized: string, node: Node): ExposedState[] {
  const memberDepth = node.kind === 'class' ? 1 : 0;
  const out: ExposedState[] = [];
  scanBalanced(JAVA_TYPE_RE, sanitized, (m, type, close) => {
    if (braceDepthAt(sanitized, m.index) !== memberDepth) return;
    let k = close + 1;
    while (k < sanitized.length && /\s/.test(sanitized[k]!)) k++;
    const nameM = /^([A-Za-z_$][\w$]*)/.exec(sanitized.slice(k));
    if (!nameM) return;
    let k2 = k + nameM[1]!.length;
    while (k2 < sanitized.length && /\s/.test(sanitized[k2]!)) k2++;
    const next = sanitized[k2];
    // method (`name(`) or field (`name;` / `name =` / `name,`); a `name.`/`name<`
    // is a chained call / cast, not an exposure.
    if (next === '(' || next === ';' || next === '=' || next === ',') {
      out.push({ name: nameM[1]!, flowKind: m[1]!, type });
    }
  });
  return out;
}

/** Brace `{`/`}` nesting depth at index `idx` (string/comment braces already blanked). */
function braceDepthAt(sanitized: string, idx: number): number {
  let depth = 0;
  for (let i = 0; i < idx; i++) {
    if (sanitized[i] === '{') depth++;
    else if (sanitized[i] === '}') depth--;
  }
  return depth;
}

/**
 * Run a `…<` regex over `sanitized`, resolving the BALANCED `<…>` after each
 * match and invoking `emit` with the match, the inner type text, and the close
 * index. Resumes past the balanced close so nested generics never re-trigger.
 */
function scanBalanced(
  re: RegExp,
  sanitized: string,
  emit: (m: RegExpExecArray, type: string, close: number) => void
): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sanitized)) !== null) {
    const open = re.lastIndex - 1; // index of the matched `<`
    const close = matchBracket(sanitized, open);
    if (close === -1) continue; // unbalanced — skip, resume after this `<`
    emit(m, sanitized.slice(open + 1, close).trim(), close);
    re.lastIndex = close + 1;
  }
}
