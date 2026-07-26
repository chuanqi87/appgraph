/**
 * Re-export of the capability → HarmonyOS API marker table.
 *
 * The table itself moved to `appgraph/detect/capability-markers.ts` so the
 * HarmonyOS platform producer can use it without violating the layering
 * invariant (`src/appgraph/` must not import `src/migration/`). This module
 * stays so the verify/plan import paths — and their tests — keep working.
 */

export {
  capabilityMarkers,
  VERIFIABLE_SPECS,
  UNVERIFIABLE_CAPABILITY_IDS,
  capabilityForImport,
} from '../../appgraph/detect/capability-markers';
