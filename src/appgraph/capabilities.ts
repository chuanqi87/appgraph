/**
 * Platform-neutral capability vocabulary.
 *
 * `Capability` is the cross-platform comparison anchor: page names differ across
 * Android/HarmonyOS/iOS, but "this app can use the camera / run a VPN / post
 * notifications" is platform-neutral and enumerable. Per-platform permission →
 * capability maps (Android in `extractors/android/capabilities.ts`, HarmonyOS in
 * its own extractor) normalize onto these ids so a cross-platform diff aligns
 * directly. This vocabulary lives in the neutral layer so `schema.ts` can depend
 * on it without reaching into any platform extractor.
 *
 * This list IS a deterministic reference asset — it grows over time and its
 * completeness bounds comparison quality. Anything unmapped is surfaced as a
 * coverageWarning rather than silently dropped.
 */

/** Controlled vocabulary. Dotted names namespace a family (e.g. `location.fine`). */
export const CAPABILITY_IDS = [
  'network',
  'network.state',
  'network.wifi',
  'internet',
  'vpn',
  'location.fine',
  'location.coarse',
  'location.background',
  'camera',
  'microphone',
  'notification',
  'contacts.read',
  'contacts.write',
  'phone.call',
  'phone.state',
  'sms.send',
  'sms.receive',
  'storage.read',
  'storage.write',
  'storage.media',
  'bluetooth',
  'nfc',
  'biometric',
  'background.foreground-service',
  'background.wakelock',
  'background.boot',
  'background.job',
  'vibrate',
  'audio.playback',
] as const;
export type CapabilityId = (typeof CAPABILITY_IDS)[number];

const CAPABILITY_ID_SET = new Set<string>(CAPABILITY_IDS);
export function isCapabilityId(value: string): value is CapabilityId {
  return CAPABILITY_ID_SET.has(value);
}
