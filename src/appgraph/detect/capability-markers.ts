/**
 * Capability → HarmonyOS API marker table.
 *
 * A capability's presence in an ArkTS project is recognized by the
 * `@ohos.*`/`@kit.*`/`@Component`… tokens its construct mappings mention. This
 * derivation is pure capability-spec logic (no ArkTS parsing), shared by the
 * HarmonyOS source producer, the migration verify stage's source-side
 * verifiable-capability filter, and its target-side projection — hence its own
 * module rather than living in a parser.
 *
 * Lives in `appgraph/` (not `migration/verify/`) because the HarmonyOS platform
 * producer needs it and the layering invariant forbids `appgraph/` importing
 * `migration/`. `migration/verify/capability-markers.ts` re-exports it verbatim.
 */

import { CAPABILITY_SPECS, CapabilitySpec } from './api-capabilities';

/** HarmonyOS API markers a capability's presence can be detected by. */
export function capabilityMarkers(spec: CapabilitySpec): string[] {
  const text = [spec.harmony.module, ...(spec.harmony.constructs ?? []).map((c) => c.to)].join(' ');
  const tokens = [...text.matchAll(/@[A-Za-z][\w.]*/g)].map((m) => m[0]);
  return [...new Set(tokens)];
}

/** Capabilities that CAN be verified (have at least one detectable marker). */
export const VERIFIABLE_SPECS: Array<{ spec: CapabilitySpec; markers: string[] }> = CAPABILITY_SPECS
  .map((spec) => ({ spec, markers: capabilityMarkers(spec) }))
  .filter((x) => x.markers.length > 0);

/** Capability ids with no auto-detectable marker (construct-only mappings). */
const VERIFIABLE_IDS = new Set(VERIFIABLE_SPECS.map((x) => x.spec.id));
export const UNVERIFIABLE_CAPABILITY_IDS: string[] = CAPABILITY_SPECS
  .filter((s) => !VERIFIABLE_IDS.has(s.id))
  .map((s) => s.id);

/** The capability an `@ohos.*`/`@kit.*` import path implies, or null. */
export function capabilityForImport(from: string): string | null {
  for (const { spec, markers } of VERIFIABLE_SPECS) {
    for (const marker of markers) {
      if (from === marker || from.startsWith(`${marker}.`)) return spec.id;
    }
  }
  return null;
}
