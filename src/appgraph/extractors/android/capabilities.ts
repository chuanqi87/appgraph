/**
 * Android permission → capability mappings.
 *
 * The controlled capability vocabulary itself lives in the neutral
 * `appgraph/capabilities.ts`; this module maps Android's permission strings onto
 * those ids. HarmonyOS's table is the sibling
 * `extractors/harmony/capabilities.ts` — because both platforms normalize to one
 * capability id, the diff aligns them directly: Android CAMERA and HarmonyOS
 * CAMERA both become `capability:camera`.
 *
 * This table IS a deterministic reference asset — it grows over time and its
 * completeness bounds comparison quality. Anything unmapped is surfaced as a
 * coverageWarning rather than silently dropped.
 */

import { CapabilityId } from '../../capabilities';

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
  'android.permission.ANSWER_PHONE_CALLS': 'phone.call',
  'android.permission.MANAGE_OWN_CALLS': 'phone.call',
  'android.permission.BIND_INCALL_SERVICE': 'phone.call',
  'android.permission.READ_PHONE_STATE': 'phone.state',
  'android.permission.MODIFY_PHONE_STATE': 'phone.state',
  'android.permission.READ_CALL_LOG': 'call-log',
  'android.permission.WRITE_CALL_LOG': 'call-log',
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
  'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK': 'background.foreground-service',
  'android.permission.WAKE_LOCK': 'background.wakelock',
  'android.permission.RECEIVE_BOOT_COMPLETED': 'background.boot',
  'android.permission.VIBRATE': 'vibrate',
  'android.permission.CAPTURE_AUDIO_OUTPUT': 'audio.playback',
  'android.permission.BIND_QUICK_SETTINGS_TILE': 'quick-settings.tile',
  'android.permission.QUERY_ALL_PACKAGES': 'package.query',
};

/** Returns the capability for an Android permission, or null if unmapped. */
export function androidPermissionToCapability(permission: string): CapabilityId | null {
  return ANDROID_PERMISSION_TO_CAPABILITY[permission] ?? null;
}
