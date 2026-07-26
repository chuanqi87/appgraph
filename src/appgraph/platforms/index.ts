/**
 * Platform producer registry.
 *
 * Mirrors the framework-resolver registry in `src/resolution/frameworks/index.ts`:
 * a module-level array plus a register hook, so adding a platform is one new
 * file and one array entry rather than edits scattered through the pipeline.
 */

import type { AppPlatform } from '../schema';
import type { PlatformDetection, PlatformProducer } from './types';
import { androidProducer } from './android';
import { harmonyProducer } from './harmony';

const PLATFORM_PRODUCERS: PlatformProducer[] = [androidProducer, harmonyProducer];

/** All registered producers, in registration order. */
export function listPlatformProducers(): readonly PlatformProducer[] {
  return PLATFORM_PRODUCERS;
}

/** Register (or replace) a producer — the extension point for a new platform. */
export function registerPlatformProducer(producer: PlatformProducer): void {
  const existing = PLATFORM_PRODUCERS.findIndex((p) => p.platform === producer.platform);
  if (existing >= 0) PLATFORM_PRODUCERS[existing] = producer;
  else PLATFORM_PRODUCERS.push(producer);
}

/** The producer for a platform. Throws with guidance when none is wired yet. */
export function getPlatformProducer(platform: AppPlatform): PlatformProducer {
  const producer = PLATFORM_PRODUCERS.find((p) => p.platform === platform);
  if (!producer) {
    const wired = PLATFORM_PRODUCERS.map((p) => p.platform).sort().join('、');
    throw new Error(
      `平台 “${platform}” 尚未接入应用图生产者(已接入:${wired})。` +
        `若是 iOS 工程,目标侧校验请用 “migrate verify”。`
    );
  }
  return producer;
}

/**
 * Fingerprint the project root against every registered producer.
 *
 * Returns the single highest-confidence match; null when nothing matches. A tie
 * at the top is deliberately an ERROR rather than a coin flip — a hybrid tree
 * (e.g. a Flutter repo carrying both `android/` and an `ohos/` HarmonyOS module)
 * must be disambiguated by the caller, because silently picking one would build
 * a confidently-wrong graph for the other half.
 */
export function detectPlatform(root: string): PlatformDetection | null {
  const hits: PlatformDetection[] = [];
  for (const producer of PLATFORM_PRODUCERS) {
    const hit = producer.detect(root);
    if (hit) hits.push(hit);
  }
  if (hits.length === 0) return null;

  hits.sort((a, b) => b.confidence - a.confidence || a.platform.localeCompare(b.platform));
  const best = hits[0]!;
  const tied = hits.filter((h) => h.confidence === best.confidence);
  if (tied.length > 1) {
    const detail = tied.map((h) => `${h.platform}(${h.evidence})`).join('、');
    throw new Error(
      `工程根同时匹配多个平台:${detail}——请用 --platform 显式指定要构建哪一个`
    );
  }
  return best;
}

export type { PlatformDetection, PlatformProducer, SemanticsInput, ImportCapabilityMatcher } from './types';
