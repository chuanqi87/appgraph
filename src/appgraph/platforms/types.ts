/**
 * Platform producer — the ONE seam through which a platform plugs into
 * `buildAppGraph`.
 *
 * The AppGraph schema (node/edge kinds, matchKey family, capability vocabulary)
 * is platform-NEUTRAL by design and is shared verbatim across Android /
 * HarmonyOS / iOS. What genuinely differs per platform is only four things:
 *
 *   M1  the declared module skeleton      (settings.gradle ↔ build-profile.json5)
 *   M3a the API-import → capability table (androidx.… ↔ @kit.… / @ohos.…)
 *   M3b the manifest-declared capabilities (AndroidManifest.xml ↔ module.json5)
 *   U   the semantic pass orchestration   (Compose/Room/Hilt ↔ ArkUI/Navigation)
 *
 * Everything else — community detection, module assignment, merge, serialization
 * — operates on the neutral schema and is reused unchanged. Keeping the seam
 * this narrow is deliberate: a new platform is one producer file plus its
 * extractors, never a sweep of `if (platform === …)` through the pipeline.
 */

import type { AppNode, AppNodeKind, AppPlatform } from '../schema';
import type { CodeSymbolGraph } from '../graph-reader';
import type { ModuleSkeleton } from '../modules/gradle-ext';
import type { ManifestCapabilityResult, ModuleRef } from '../detect/manifest-capabilities';
import type { SemanticsResult } from '../detect/semantics';

/** Deterministic filesystem fingerprint backing `--platform auto`. */
export interface PlatformDetection {
  platform: AppPlatform;
  /** 0–1. 1 = a uniquely authoritative marker (`AppScope/`, `settings.gradle`). */
  confidence: number;
  /** Human-readable evidence — shown by the CLI, recorded in warnings. */
  evidence: string;
}

/** Everything the U (semantics) stage needs, bundled so the seam stays one arg. */
export interface SemanticsInput {
  reader: CodeSymbolGraph;
  root: string;
  archModules: AppNode[];
  nodeToModuleId: Map<string, string>;
}

/** Maps a resolved import FQN to a capability id, or null when it implies none. */
export type ImportCapabilityMatcher = (importFqn: string) => string | null;

export interface PlatformProducer {
  readonly platform: AppPlatform;
  /**
   * Node kinds this producer can ACTUALLY emit today — copied straight into
   * `AppGraph.supportedKinds`. It is an honesty contract, not an aspiration: a
   * kind listed here but never emitted makes a cross-platform diff read an
   * absence as "migrated away" instead of "not extracted".
   */
  readonly supportedKinds: readonly AppNodeKind[];
  /** Filesystem-only fingerprint (no index). null = "not this platform". */
  detect(root: string): PlatformDetection | null;
  /** M1 · declared module skeleton. */
  extractModules(root: string): ModuleSkeleton;
  /** M3a · API import → capability. */
  readonly importCapability: ImportCapabilityMatcher;
  /** M3b · manifest-declared permissions/capabilities, attributed to modules. */
  extractManifests(root: string, modules: ModuleRef[]): ManifestCapabilityResult;
  /** U · semantic enrichment passes. */
  buildSemantics(input: SemanticsInput): SemanticsResult;
}
