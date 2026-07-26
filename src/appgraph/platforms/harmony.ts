/**
 * HarmonyOS platform producer.
 *
 * Mirrors `android.ts`: this file only WIRES passes, it holds no analysis logic.
 * The HarmonyOS-specific extraction lives under `extractors/harmony/` and
 * `detect/harmony-*.ts`.
 *
 * `supportedKinds` is deliberately narrower than Android's and grows as passes
 * land. It is an honesty contract, not a roadmap: a cross-platform diff reads a
 * kind's absence as "migrated away" only when the producer CLAIMS to emit it.
 */

import type { AppNodeKind } from '../schema';
import { extractHarmonyModuleSkeleton } from '../modules/harmony-ext';
import { harmonyImportToCapability } from '../extractors/harmony/capabilities';
import { isHarmonyProjectRoot } from '../extractors/harmony/project';
import { detectHarmonyManifests } from '../detect/harmony-manifest-capabilities';
import { buildHarmonySemantics } from '../detect/harmony-semantics';
import type { PlatformDetection, PlatformProducer } from './types';

/** Node kinds the HarmonyOS pipeline emits. */
const HARMONY_SUPPORTED_KINDS: readonly AppNodeKind[] = [
  'AppEntry',
  'Screen',
  'DataModel',
  'BackgroundComponent',
  'Permission',
  'Capability',
  'ArchModule',
  'Resource',
  'Feature',
];

/** `AppScope/app.json5` is the one authoritative HarmonyOS root marker. */
function detectHarmony(root: string): PlatformDetection | null {
  return isHarmonyProjectRoot(root)
    ? { platform: 'harmony', confidence: 1, evidence: 'AppScope/app.json5' }
    : null;
}

export const harmonyProducer: PlatformProducer = {
  platform: 'harmony',
  supportedKinds: HARMONY_SUPPORTED_KINDS,
  detect: detectHarmony,
  extractModules: extractHarmonyModuleSkeleton,
  importCapability: harmonyImportToCapability,
  extractManifests: (root, modules) => detectHarmonyManifests(root, modules),
  buildSemantics: buildHarmonySemantics,
};
