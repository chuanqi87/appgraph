/**
 * Android platform producer — a pure forwarding adapter.
 *
 * Every pass it names already existed and is referenced verbatim; this file adds
 * no analysis logic of its own. That is the point: introducing the producer seam
 * must not perturb the Android pipeline by a single node or edge (locked by
 * `__tests__/appgraph/build-parity.test.ts`).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AppNodeKind } from '../schema';
import { extractModuleSkeleton } from '../modules/gradle-ext';
import { apiToCapability } from '../detect/api-capabilities';
import { detectManifestCapabilities } from '../detect/manifest-capabilities';
import { buildSemantics } from '../detect/semantics';
import type { PlatformDetection, PlatformProducer } from './types';

/** Node kinds the Android source pipeline emits. */
const ANDROID_SUPPORTED_KINDS: readonly AppNodeKind[] = [
  'AppEntry',
  'Screen',
  'BackgroundComponent',
  'Permission',
  'Capability',
  'ArchModule',
  'Resource',
  'DataModel',
  'Feature',
];

/** `settings.gradle(.kts)` is the authoritative marker of a Gradle project root. */
const SETTINGS_FILES = ['settings.gradle.kts', 'settings.gradle'];

function detectAndroid(root: string): PlatformDetection | null {
  for (const name of SETTINGS_FILES) {
    if (existsSync(join(root, name))) {
      return { platform: 'android', confidence: 1, evidence: name };
    }
  }
  // A bare module checkout can lack settings.gradle but still be Gradle-built.
  for (const name of ['build.gradle.kts', 'build.gradle']) {
    if (existsSync(join(root, name))) {
      return { platform: 'android', confidence: 0.6, evidence: name };
    }
  }
  return null;
}

export const androidProducer: PlatformProducer = {
  platform: 'android',
  supportedKinds: ANDROID_SUPPORTED_KINDS,
  detect: detectAndroid,
  extractModules: extractModuleSkeleton,
  importCapability: apiToCapability,
  extractManifests: (root, modules) => detectManifestCapabilities(root, modules),
  buildSemantics: ({ reader, root, archModules, nodeToModuleId }) =>
    buildSemantics(reader, root, archModules, nodeToModuleId),
};
