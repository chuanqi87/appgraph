/**
 * Capability vocabulary + platform permission → capability mappings.
 *
 * `Capability` is the cross-platform comparison anchor: page names differ
 * across Android/HarmonyOS/iOS, but "this app can use the camera / run a VPN /
 * post notifications" is platform-neutral and enumerable. The diff stage aligns
 * two app graphs primarily on these capability ids.
 *
 * This table IS the deterministic reference asset — it grows over time and its
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

/**
 * Android `android.permission.*` (and a few component-declared permissions) →
 * capability id. Keyed by the FULL permission string so lookups are exact.
 */
const ANDROID_PERMISSION_TO_CAPABILITY: Record<string, CapabilityId> = {
  'android.permission.INTERNET': 'internet',
  'android.permission.ACCESS_NETWORK_STATE': 'network.state',
  'android.permission.CHANGE_NETWORK_STATE': 'network',
  'android.permission.ACCESS_WIFI_STATE': 'network.wifi',
  'android.permission.CHANGE_WIFI_STATE': 'network.wifi',
  'android.permission.BIND_VPN_SERVICE': 'vpn',
  'android.permission.ACCESS_FINE_LOCATION': 'location.fine',
  'android.permission.ACCESS_COARSE_LOCATION': 'location.coarse',
  'android.permission.ACCESS_BACKGROUND_LOCATION': 'location.background',
  'android.permission.CAMERA': 'camera',
  'android.permission.RECORD_AUDIO': 'microphone',
  'android.permission.POST_NOTIFICATIONS': 'notification',
  'android.permission.READ_CONTACTS': 'contacts.read',
  'android.permission.WRITE_CONTACTS': 'contacts.write',
  'android.permission.CALL_PHONE': 'phone.call',
  'android.permission.READ_PHONE_STATE': 'phone.state',
  'android.permission.SEND_SMS': 'sms.send',
  'android.permission.RECEIVE_SMS': 'sms.receive',
  'android.permission.READ_EXTERNAL_STORAGE': 'storage.read',
  'android.permission.WRITE_EXTERNAL_STORAGE': 'storage.write',
  'android.permission.READ_MEDIA_IMAGES': 'storage.media',
  'android.permission.READ_MEDIA_VIDEO': 'storage.media',
  'android.permission.READ_MEDIA_AUDIO': 'storage.media',
  'android.permission.BLUETOOTH': 'bluetooth',
  'android.permission.BLUETOOTH_CONNECT': 'bluetooth',
  'android.permission.NFC': 'nfc',
  'android.permission.USE_BIOMETRIC': 'biometric',
  'android.permission.USE_FINGERPRINT': 'biometric',
  'android.permission.FOREGROUND_SERVICE': 'background.foreground-service',
  'android.permission.FOREGROUND_SERVICE_SPECIAL_USE': 'background.foreground-service',
  'android.permission.FOREGROUND_SERVICE_SYSTEM_EXEMPTED': 'background.foreground-service',
  'android.permission.WAKE_LOCK': 'background.wakelock',
  'android.permission.RECEIVE_BOOT_COMPLETED': 'background.boot',
  'android.permission.VIBRATE': 'vibrate',
};

/** Returns the capability for an Android permission, or null if unmapped. */
export function androidPermissionToCapability(permission: string): CapabilityId | null {
  return ANDROID_PERMISSION_TO_CAPABILITY[permission] ?? null;
}

/**
 * HarmonyOS `ohos.permission.*` → the SAME capability vocabulary. Because both
 * platforms normalize to one capability id, the diff aligns them directly:
 * Android CAMERA and HarmonyOS CAMERA both become `capability:camera`.
 */
const HARMONY_PERMISSION_TO_CAPABILITY: Record<string, CapabilityId> = {
  'ohos.permission.INTERNET': 'internet',
  'ohos.permission.GET_NETWORK_INFO': 'network.state',
  'ohos.permission.SET_NETWORK_INFO': 'network',
  'ohos.permission.GET_WIFI_INFO': 'network.wifi',
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
  'ohos.permission.GET_TELEPHONY_STATE': 'phone.state',
  'ohos.permission.SEND_MESSAGES': 'sms.send',
  'ohos.permission.RECEIVE_SMS': 'sms.receive',
  'ohos.permission.READ_MEDIA': 'storage.read',
  'ohos.permission.WRITE_MEDIA': 'storage.write',
  'ohos.permission.READ_IMAGEVIDEO': 'storage.media',
  'ohos.permission.USE_BLUETOOTH': 'bluetooth',
  'ohos.permission.NFC_TAG': 'nfc',
  'ohos.permission.ACCESS_BIOMETRIC': 'biometric',
  'ohos.permission.KEEP_BACKGROUND_RUNNING': 'background.foreground-service',
  'ohos.permission.RUNNING_LOCK': 'background.wakelock',
  'ohos.permission.VIBRATE': 'vibrate',
};

/** Returns the capability for a HarmonyOS permission, or null if unmapped. */
export function harmonyPermissionToCapability(permission: string): CapabilityId | null {
  return HARMONY_PERMISSION_TO_CAPABILITY[permission] ?? null;
}
