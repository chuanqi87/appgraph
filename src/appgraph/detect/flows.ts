/**
 * U5 · async / reactive data flow (lightweight).
 *
 * Kotlin apps push UI state through `StateFlow`/`Flow`/`LiveData`; the ArkTS
 * equivalent is `@State` + an emitter, so the LLM needs to know which reactive
 * states a module EXPOSES and where they are COLLECTED. This does not attempt a
 * full def-use analysis (that is codegraph/ArkAnalyzer's job) — it records the
 * exposure/collection contract as per-module facts that anchor the translation.
 */

import { CoverageWarning } from '../schema';
import { Node } from '../../types';
import { sanitizeKotlin } from './kotlin-source';
import { DetectContext, isShippableJvmNode, ReadCode } from './shared';

/** Reactive-flow facts for one ArchModule (attached to its attrs). */
export interface FlowFacts {
  /** Exposed reactive properties (name + flow kind). */
  exposedStates: Array<{ name: string; type: string; flowKind: string }>;
  /** Count of collection sites (`collectAsState`, `.collect{}`, `observeAsState`). */
  collectPoints: number;
}

export interface FlowResult {
  flowsByModule: Map<string, FlowFacts>;
  warnings: CoverageWarning[];
  stats: { exposedStates: number; collectPoints: number; modulesWithFlow: number };
}

const EXPOSE_RE =
  /\bval\s+(\w+)\s*:\s*(StateFlow|MutableStateFlow|SharedFlow|MutableSharedFlow|Flow|LiveData|MutableLiveData)\s*<([^>]*)>/g;
const COLLECT_RE = /collectAsStateWithLifecycle|collectAsState|observeAsState|\.collect\s*[{(]/g;

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

    EXPOSE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = EXPOSE_RE.exec(sanitized)) !== null) {
      const f = factsFor(moduleId);
      if (!f.exposedStates.some((s) => s.name === m![1])) {
        f.exposedStates.push({ name: m[1]!, flowKind: m[2]!, type: m[3]!.trim() });
        exposedTotal++;
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
