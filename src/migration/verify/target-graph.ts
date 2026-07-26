/**
 * M4 · TARGET-side reconstruction via the community tree-sitter engine.
 *
 * The SOURCE side lifts its AppGraph from a `codegraph index` of the source
 * project; the TARGET side is symmetric: index the generated HarmonyOS output
 * with the SAME community engine (the `.ets` arkts extractor), then read the
 * code-symbol graph back and project it to the target AppGraph surface.
 *
 * The projection itself lives in `appgraph/extractors/harmony/surface.ts` and is
 * SHARED with `appgraph build --platform harmony`, so a HarmonyOS project gets
 * the same screens/capabilities/nav whether it is analyzed standalone or as a
 * migration target. This module owns only the verify-specific parts: index
 * lifecycle, source reading, and the degraded-surface contract.
 *
 * Indexing is auto-managed exactly like `migrate index`: open+sync an existing
 * `.codegraph/`, else init+index. Any failure degrades to an empty surface with
 * `structural.buildOk=false` so `verify` reports "target unparseable" instead of
 * throwing.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppNode } from '../../appgraph/schema';
import type { NavEdge } from './structure-diff';
import { CodeSymbolGraph } from '../../appgraph/graph-reader';
import { CodeGraph } from '../../index';
import { projectHarmonySurface } from '../../appgraph/extractors/harmony/surface';
import type { ArkExport, ArkExportKind } from '../../appgraph/extractors/harmony/surface';
import { UNVERIFIABLE_CAPABILITY_IDS } from './capability-markers';

export type { ArkExport, ArkExportKind };

/** Structural-validity signal: did the target index build, and what did it yield. */
export interface TargetStructural {
  buildOk: boolean;
  fileCount: number;
  classCount: number;
  methodCount: number;
  /** Capability ids detected, sorted (for the diff). */
  capabilityIds: string[];
}

/**
 * The recovered target surface. Shared by the full-project and per-unit gates so
 * the target is indexed + read once per verify.
 */
export interface TargetSurface {
  /** Always 'codegraph' now — the single community tree-sitter path. */
  method: 'codegraph';
  capabilityNodes: AppNode[];
  screenNodes: AppNode[];
  /** Router navigation edges recovered from route literals (from → to page). */
  navEdges: NavEdge[];
  exports: ArkExport[];
  structural: TargetStructural;
  fileCount: number;
  /** Capability ids that carry no auto-detectable marker (construct mappings). */
  unverifiable: string[];
}

/** Index (auto-managed) the generated target and project it to the surface. */
export async function resolveTargetSurface(targetRoot: string): Promise<TargetSurface> {
  try {
    await ensureIndexed(targetRoot);
  } catch {
    return emptySurface();
  }

  let reader: CodeSymbolGraph;
  try {
    reader = CodeSymbolGraph.open(targetRoot);
  } catch {
    return emptySurface();
  }
  try {
    const surface = projectHarmonySurface({
      nodes: reader.getAllNodes(),
      edges: reader.getAllEdges(),
      readSource: memoizedSourceReader(targetRoot),
    });
    return {
      method: 'codegraph',
      capabilityNodes: surface.capabilityNodes,
      screenNodes: surface.screenNodes,
      navEdges: surface.navEdges,
      exports: surface.exports,
      structural: { buildOk: true, ...surface.structural },
      fileCount: surface.fileCount,
      unverifiable: UNVERIFIABLE_CAPABILITY_IDS,
    };
  } catch {
    return emptySurface();
  } finally {
    reader.close();
  }
}

/** open+sync an existing `.codegraph/`, else init+index — mirrors `migrate index`. */
async function ensureIndexed(targetRoot: string): Promise<void> {
  const cg = CodeGraph.isInitialized(targetRoot)
    ? await CodeGraph.open(targetRoot, { sync: true })
    : await CodeGraph.init(targetRoot, { index: true });
  cg.close();
}

/** Read each project-relative file at most once; unreadable → '' (never throws). */
function memoizedSourceReader(root: string): (filePath: string) => string {
  const cache = new Map<string, string>();
  return (filePath: string): string => {
    let src = cache.get(filePath);
    if (src === undefined) {
      try {
        src = readFileSync(join(root, filePath), 'utf8');
      } catch {
        src = '';
      }
      cache.set(filePath, src);
    }
    return src;
  };
}

/** Degraded surface — indexing/reading failed; verify reports it as unparseable. */
function emptySurface(): TargetSurface {
  return {
    method: 'codegraph',
    capabilityNodes: [],
    screenNodes: [],
    navEdges: [],
    exports: [],
    structural: { buildOk: false, fileCount: 0, classCount: 0, methodCount: 0, capabilityIds: [] },
    fileCount: 0,
    unverifiable: UNVERIFIABLE_CAPABILITY_IDS,
  };
}
