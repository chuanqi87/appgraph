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

/**
 * Any source-set segment containing "test" — `src/test/`, `src/androidTest/`,
 * plus variant/fixture sets (`src/testDemo/`, `src/testFixtures/`,
 * `src/screenshotTest/`, …) which the old fixed alternation missed and which
 * let test files leak into the shipped app graph (nowinandroid's `testDemo`).
 */
const TEST_PATH_RE = /\/src\/[^/]*test[^/]*\//i;

/** True for symbols under a test source set (excluded from the shipped app graph). */
export function isTestPath(filePath: string): boolean {
  return TEST_PATH_RE.test(filePath);
}

/** Kotlin/Java source symbol under a shippable source set. */
export function isShippableJvmNode(node: Node): boolean {
  return (node.language === 'kotlin' || node.language === 'java') && !isTestPath(node.filePath);
}

/**
 * True for Gradle/Kotlin build scripts and build-tooling sources — files whose
 * symbols pollute the app graph (interfaces, communities) with non-product noise.
 * Conservative on purpose (a false negative merely keeps a symbol; a false
 * positive silently drops product code):
 *
 *  - any `*.gradle` / `*.gradle.kts` (covers `build.gradle`, `settings.gradle`,
 *    and their `.kts` variants);
 *  - a `buildSrc/` or `build-logic/` path segment (Gradle convention plugins,
 *    version catalogs, build logic);
 *  - a Python file OUTSIDE any source set (`setup.py`, gradle/CI helper scripts,
 *    …) — a `.py` under `/src/…` is treated as product code and KEPT.
 *
 * This is the shared T1-8 primitive; consumers (community detection, and the plan
 * layer) import it rather than re-deriving the rule.
 */
export function isBuildFilePath(path: string): boolean {
  const posix = path.replace(/\\/g, '/');
  const base = posix.slice(posix.lastIndexOf('/') + 1);
  if (/\.gradle(\.kts)?$/.test(base)) return true;
  const segments = posix.split('/');
  if (segments.includes('buildSrc') || segments.includes('build-logic')) return true;
  if (base.endsWith('.py') && !posix.includes('/src/')) return true;
  return false;
}
