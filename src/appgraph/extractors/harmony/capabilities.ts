/**
 * HarmonyOS permission → capability mappings.
 *
 * The controlled capability vocabulary itself lives in the neutral
 * `appgraph/capabilities.ts`; this module maps HarmonyOS's `ohos.permission.*`
 * strings onto those ids. Because both platforms normalize to one capability id,
 * the diff aligns them directly: Android CAMERA and HarmonyOS CAMERA both become
 * `capability:camera`.
 *
 * This table IS a deterministic reference asset — it grows over time and its
 * completeness bounds comparison quality. Anything unmapped is surfaced as a
 * coverageWarning rather than silently dropped.
 */

import { CapabilityId } from '../../capabilities';
import { capabilityForImport } from '../../detect/capability-markers';

/**
 * HarmonyOS `ohos.permission.*` → the SAME capability vocabulary Android maps
 * onto. Keyed by the FULL permission string so lookups are exact.
 */
const HARMONY_PERMISSION_TO_CAPABILITY: Record<string, CapabilityId> = {
  'ohos.permission.INTERNET': 'internet',
  'ohos.permission.GET_NETWORK_INFO': 'network.state',
  'ohos.permission.SET_NETWORK_INFO': 'network',
  'ohos.permission.GET_WIFI_INFO': 'network.wifi',
  'ohos.permission.SET_WIFI_INFO': 'network.wifi',
  'ohos.permission.MANAGE_VPN': 'vpn',
  'ohos.permission.LOCATION': 'location.fine',
  'ohos.permission.APPROXIMATELY_LOCATION': 'location.coarse',
  'ohos.permission.LOCATION_IN_BACKGROUND': 'location.background',
  'ohos.permission.CAMERA': 'camera',
  'ohos.permission.MICROPHONE': 'microphone',
  'ohos.permission.NOTIFICATION_CONTROLLER': 'notification',
  'ohos.permission.READ_CONTACTS': 'contacts.read',
  'ohos.permission.WRITE_CONTACTS': 'contacts.write',
  'ohos.permission.PLACE_CALL': 'phone.call',
  'ohos.permission.ANSWER_CALL': 'phone.call',
  'ohos.permission.GET_TELEPHONY_STATE': 'phone.state',
  'ohos.permission.READ_CALL_LOG': 'call-log',
  'ohos.permission.WRITE_CALL_LOG': 'call-log',
  'ohos.permission.SEND_MESSAGES': 'sms.send',
  'ohos.permission.RECEIVE_SMS': 'sms.receive',
  'ohos.permission.READ_MEDIA': 'storage.read',
  'ohos.permission.WRITE_MEDIA': 'storage.write',
  'ohos.permission.READ_IMAGEVIDEO': 'storage.media',
  'ohos.permission.WRITE_IMAGEVIDEO': 'storage.media',
  'ohos.permission.READ_AUDIO': 'storage.media',
  'ohos.permission.WRITE_AUDIO': 'storage.media',
  'ohos.permission.MEDIA_LOCATION': 'storage.media',
  'ohos.permission.USE_BLUETOOTH': 'bluetooth',
  'ohos.permission.ACCESS_BLUETOOTH': 'bluetooth',
  'ohos.permission.DISCOVER_BLUETOOTH': 'bluetooth',
  'ohos.permission.NFC_TAG': 'nfc',
  'ohos.permission.NFC_CARD_EMULATION': 'nfc',
  'ohos.permission.ACCESS_BIOMETRIC': 'biometric',
  'ohos.permission.KEEP_BACKGROUND_RUNNING': 'background.foreground-service',
  'ohos.permission.RUNNING_LOCK': 'background.wakelock',
  'ohos.permission.VIBRATE': 'vibrate',
  'ohos.permission.GET_INSTALLED_BUNDLE_LIST': 'package.query',
};

/*
 * Deliberately unmapped: `READ_CALENDAR` / `WRITE_CALENDAR` / `ACCELEROMETER` /
 * `GYROSCOPE` / `ACTIVITY_MOTION` / `APP_TRACKING_CONSENT` /
 * `DISTRIBUTED_DATASYNC` have no id in the neutral vocabulary yet. They surface
 * as a coverageWarning rather than an invented id — widening the vocabulary is a
 * cross-platform change (Android's READ_CALENDAR / BODY_SENSORS are equally
 * unmapped) and belongs with the capability-mapping work, not here.
 */
/** Returns the capability for a HarmonyOS permission, or null if unmapped. */
export function harmonyPermissionToCapability(permission: string): CapabilityId | null {
  return HARMONY_PERMISSION_TO_CAPABILITY[permission] ?? null;
}

/**
 * HarmonyOS import specifier → capability, for imports the spec-marker table
 * cannot recognize.
 *
 * Two gaps it closes, both measured on the corpus:
 *
 *  1. `@kit.*` AGGREGATES. Modern HarmonyOS imports a Kit, not a leaf module
 *     (`@kit.*` : `@ohos.*` ≈ 10,000 : 400). The spec table's markers are the
 *     leaf modules (`@ohos.data.preferences`), so a project written entirely
 *     against Kits detects almost no capabilities at all.
 *  2. THIRD-PARTY networking. `axios` / `@ohos/axios` (1,030 + 222 uses) far
 *     outweighs the native `http.createHttp` (32), so keying networking solely
 *     on `@ohos.net.http` misses the mainstream implementation.
 *
 * Prefix-matched, longest first, so `@kit.ArkData` and `@ohos.data.preferences`
 * can coexist. Ids are `CAPABILITY_SPECS` ids (a superset of the permission
 * vocabulary), keeping HarmonyOS and Android capabilities directly comparable.
 */
const HARMONY_IMPORT_TO_CAPABILITY: Array<[prefix: string, capability: string]> = [
  // --- Kit aggregates -------------------------------------------------------
  ['@kit.ArkUI', 'ui.declarative'],
  ['@kit.ArkData', 'persistence.datastore'],
  ['@kit.NetworkKit', 'network'],
  ['@kit.NotificationKit', 'notification'],
  ['@kit.LocationKit', 'location.fine'],
  ['@kit.CameraKit', 'camera'],
  ['@kit.AudioKit', 'audio.playback'],
  ['@kit.MediaKit', 'audio.playback'],
  ['@kit.AVSessionKit', 'audio.playback'],
  ['@kit.MediaLibraryKit', 'storage.media'],
  ['@kit.ImageKit', 'image.loading'],
  ['@kit.CoreFileKit', 'storage.read'],
  ['@kit.ConnectivityKit', 'bluetooth'],
  ['@kit.UserAuthenticationKit', 'biometric'],
  ['@kit.TelephonyKit', 'phone.state'],
  ['@kit.BackgroundTasksKit', 'background.task'],
  ['@kit.ArkTS', 'concurrency.async'],
  // --- Leaf modules the Kits wrap ------------------------------------------
  ['@ohos.data.relationalStore', 'persistence.database'],
  ['@ohos.data.preferences', 'persistence.datastore'],
  ['@ohos.data.distributedKVStore', 'persistence.datastore'],
  ['@ohos.file.fs', 'storage.read'],
  ['@ohos.file.photoAccessHelper', 'storage.media'],
  ['@ohos.net.http', 'network'],
  ['@ohos.net.webSocket', 'network'],
  ['@ohos.net.connection', 'network.state'],
  ['@ohos.taskpool', 'concurrency.async'],
  ['@ohos.worker', 'concurrency.async'],
  ['@ohos.util.json', 'serialization.json'],
  ['@ohos.events.emitter', 'concurrency.async'],
  ['@ohos.resourceschedule.backgroundTaskManager', 'background.foreground-service'],
  ['@ohos.resourceschedule.workScheduler', 'background.task'],
  // --- Third-party, but dominant in practice --------------------------------
  ['@ohos/axios', 'network'],
  ['axios', 'network'],
  ['@ohos/mpchart', 'image.loading'],
];

/** Longest-prefix first so a leaf module beats a Kit that also matches. */
const SORTED_IMPORT_PREFIXES = [...HARMONY_IMPORT_TO_CAPABILITY].sort(
  (a, b) => b[0].length - a[0].length
);

/**
 * The capability a HarmonyOS `import` specifier implies, or null.
 *
 * Tries the spec-marker table first — the same derivation the migration verify
 * stage uses to recognize a capability on a generated target, so a capability is
 * detected identically whether a project is analyzed standalone or as a target —
 * then falls back to the HarmonyOS-specific table above.
 */
export function harmonyImportToCapability(importFqn: string): string | null {
  const fromSpec = capabilityForImport(importFqn);
  if (fromSpec) return fromSpec;
  for (const [prefix, capability] of SORTED_IMPORT_PREFIXES) {
    if (importFqn === prefix || importFqn.startsWith(`${prefix}.`)) return capability;
  }
  return null;
}
