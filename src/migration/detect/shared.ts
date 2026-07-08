/**
 * Shared plumbing for the U-track semantic detect passes.
 *
 * Every pass reads a symbol's source span to recover facts codegraph doesn't
 * store (annotations, field schemas, flow types). `ReadCode` is a memoized
 * source reader the orchestrator hands to each pass so a span is read from disk
 * at most once across all passes. `DetectContext` carries the module attribution
 * the passes need to place their nodes/edges onto the right ArchModule.
 */

import { AppNode } from '../schema';
import { Node } from '../../types';

/** Memoized `node → source span` reader (one disk read per node across all passes). */
export type ReadCode = (node: Node) => string | null;

/** Module attribution + naming, derived once from the persisted M1 ArchModules. */
export interface DetectContext {
  /** code node id → owning ArchModule id (from the M1 assignment). */
  nodeToModuleId: Map<string, string>;
  /** ArchModule id → its human-readable name. */
  moduleNameById: Map<string, string>;
  /** ArchModule nodes (for Feature/attr enrichment by the orchestrator). */
  archModules: AppNode[];
}

const TEST_PATH_RE = /\/src\/(test|androidTest|androidtest)\//i;

/** True for symbols under a test source set (excluded from the shipped app graph). */
export function isTestPath(filePath: string): boolean {
  return TEST_PATH_RE.test(filePath);
}

/** Kotlin/Java source symbol under a shippable source set. */
export function isShippableJvmNode(node: Node): boolean {
  return (node.language === 'kotlin' || node.language === 'java') && !isTestPath(node.filePath);
}
