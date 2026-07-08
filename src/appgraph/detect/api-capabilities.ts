/**
 * M3 · API → capability detection + capability → HarmonyOS target-API table.
 *
 * The neutral `capabilities.ts` maps PERMISSIONS → capabilities (both platforms).
 * This module adds the other two halves:
 *   1. API → capability: which framework/API a module USES, detected from the
 *      code graph's `import` nodes (Retrofit → network, Room → persistence.db,
 *      WorkManager → background.task, …). Emitted as `uses_capability` edges.
 *   2. capability → HarmonyOS target API: the "how do I translate this" side —
 *      the ArkTS/HarmonyOS module + construct mapping the LLM anchors on when it
 *      generates each module.
 *
 * `CAPABILITY_SPECS` is one indivisible reference asset: each entry couples an
 * id's `apiPrefixes` (detection) with its `harmony` target (translation) and
 * `kind`. It lives in the neutral appgraph layer because it produces the app
 * graph's Capability nodes and is consumed by the neutral detect/ passes; the
 * migration layer imports its accessors from here. The capability ids are a
 * SUPERSET of the permission vocabulary — they reuse the same ids (`network`,
 * `notification`, `camera`, …) so a cross-platform diff aligns on them, and add
 * framework/construct capabilities (`persistence.database`, `ui.declarative`, …)
 * that have a target API but no permission behind them.
 */

import { AppEdge, AppNode, makeEdgeId, makeNodeId } from '../schema';
import { Node } from '../../types';

/** HarmonyOS translation target for a capability — the LLM's generation anchor. */
export interface HarmonyTarget {
  /** HarmonyOS module / kit to import (e.g. `@ohos.net.http`). */
  module: string;
  /** One-line "translate to this" note. */
  note: string;
  /** Concrete Android → HarmonyOS construct mappings. */
  constructs?: Array<{ from: string; to: string }>;
}

export interface CapabilitySpec {
  id: string;
  /** permission-backed · framework library · language/UI construct. */
  kind: 'permission' | 'framework' | 'construct';
  /** Android import prefixes whose presence implies this capability. */
  apiPrefixes: string[];
  harmony: HarmonyTarget;
}

/**
 * The controlled capability + target-API table. Order matters only for readable
 * output; matching is longest-prefix so `androidx.core.app.NotificationCompat`
 * beats a hypothetical `androidx.core` rule.
 */
export const CAPABILITY_SPECS: CapabilitySpec[] = [
  {
    id: 'network',
    kind: 'framework',
    apiPrefixes: ['retrofit2', 'okhttp3', 'okhttp', 'io.ktor', 'java.net.HttpURLConnection'],
    harmony: {
      module: '@ohos.net.http / @kit.NetworkKit(rcp)',
      note: 'Retrofit/OkHttp 的声明式 HTTP → http.createHttp().request 或 @kit.RemoteCommunicationKit(rcp);拦截器/转换器手动重建',
      constructs: [
        { from: 'Retrofit interface (@GET/@POST)', to: 'rcp.Session / http.HttpRequest 封装的 async 方法' },
        { from: 'OkHttpClient/Interceptor', to: 'rcp.Session 配置 + 自定义拦截逻辑' },
      ],
    },
  },
  {
    id: 'internet',
    kind: 'framework',
    apiPrefixes: ['com.google.firebase', 'com.google.android.gms'],
    harmony: {
      module: 'HMS / AGConnect',
      note: 'Firebase/GMS 服务 → 华为对应服务(Push Kit / Account Kit / Analytics Kit);无直接等价者需替换方案',
    },
  },
  {
    id: 'image.loading',
    kind: 'framework',
    apiPrefixes: ['coil', 'com.bumptech.glide', 'com.squareup.picasso'],
    harmony: {
      module: 'Image 组件 + @ohos.request',
      note: 'Coil/Glide 异步图片加载 → ArkUI Image($rawfile/网络URL)配合 image 缓存;占位/变换用 Image 属性',
    },
  },
  {
    id: 'persistence.database',
    kind: 'framework',
    apiPrefixes: ['androidx.room', 'android.database.sqlite'],
    harmony: {
      module: '@ohos.data.relationalStore',
      note: 'Room/SQLite → relationalStore.getRdbStore + RdbPredicates;@Entity→建表 SQL,@Dao→封装的 CRUD 方法,Flow 查询→回调/emitter',
      constructs: [
        { from: '@Entity data class', to: 'ValuesBucket + 建表语句' },
        { from: '@Dao interface', to: '封装 RdbStore 的 class' },
        { from: 'Flow<List<T>> 查询', to: 'query() + 手动 emitter 通知' },
      ],
    },
  },
  {
    id: 'persistence.datastore',
    kind: 'framework',
    apiPrefixes: ['androidx.datastore', 'android.content.SharedPreferences'],
    harmony: {
      module: '@ohos.data.preferences',
      note:
        '同步的 SharedPreferences → 同步 API(getPreferencesSync/getSync/putSync/flushSync),' +
        '保留原逐调用点同步语义,不必把读写点全改成 await;异步 DataStore(Flow/挂起)→ ' +
        'Promise 版(getPreferences/get/put/flush);Proto DataStore 的类型化模型手动序列化',
      constructs: [
        { from: 'SharedPreferences getString/getInt (同步)', to: 'preferences.getPreferencesSync + getSync' },
        { from: 'editor.putX().apply()/commit()', to: 'putSync + flushSync(同步落盘)' },
        { from: 'DataStore Flow<Preferences> (异步)', to: 'preferences.getPreferences + get/put/flush(Promise)' },
      ],
    },
  },
  {
    id: 'serialization.json',
    kind: 'framework',
    apiPrefixes: ['kotlinx.serialization', 'com.squareup.moshi', 'com.google.gson'],
    harmony: {
      module: 'ArkTS JSON / @ohos.util.json',
      note: 'kotlinx.serialization/Moshi/Gson → JSON.parse/JSON.stringify 或 util 转换;@Serializable 模型改为 interface/class',
    },
  },
  {
    id: 'concurrency.async',
    kind: 'construct',
    apiPrefixes: ['kotlinx.coroutines', 'io.reactivex', 'io.reactivex.rxjava3'],
    harmony: {
      module: 'Promise/async-await + @ohos.taskpool',
      note: 'Coroutine/Flow → async/await + Promise;CPU 密集任务用 taskpool/Worker;Flow 冷流 → 自建 emitter 或 AsyncIterator',
      constructs: [
        { from: 'suspend fun', to: 'async 函数返回 Promise' },
        { from: 'Flow<T> / StateFlow', to: '@State + 回调 或 emitter' },
        { from: 'CoroutineScope/Dispatchers', to: 'taskpool.execute / Worker' },
      ],
    },
  },
  {
    id: 'di.inject',
    kind: 'framework',
    apiPrefixes: ['dagger', 'javax.inject', 'org.koin'],
    harmony: {
      module: '手动依赖注入 / AppStorage',
      note: 'Hilt/Dagger/Koin → HarmonyOS 无等价 DI 框架:改为构造器手动注入 或 全局 AppStorage/单例;@Inject 点显式 new',
      constructs: [
        { from: '@HiltViewModel / @Inject', to: '构造器传参 或 单例 provider' },
        { from: '@Module/@Provides', to: '手写工厂函数' },
      ],
    },
  },
  {
    id: 'ui.declarative',
    kind: 'construct',
    apiPrefixes: ['androidx.compose'],
    harmony: {
      module: 'ArkUI (@Component/@Entry)',
      note: 'Jetpack Compose → ArkUI 声明式:@Composable→@Component struct 的 build();Modifier→属性链;remember/State→@State;导航→router/Navigation',
      constructs: [
        { from: '@Composable fun', to: '@Component struct { build() { … } }' },
        { from: 'Modifier 链', to: '组件属性方法链(.width().padding())' },
        { from: 'remember { mutableStateOf }', to: '@State 装饰的成员变量' },
        { from: 'LazyColumn/LazyRow', to: 'List + LazyForEach' },
      ],
    },
  },
  {
    id: 'background.task',
    kind: 'framework',
    apiPrefixes: ['androidx.work', 'android.app.job'],
    harmony: {
      module: '@ohos.resourceschedule.workScheduler',
      note: 'WorkManager/JobScheduler → workScheduler.startWork(延迟/周期任务)或 backgroundTaskManager(短时任务);约束条件映射到 WorkInfo',
    },
  },
  {
    id: 'notification',
    kind: 'permission',
    apiPrefixes: ['androidx.core.app.NotificationCompat', 'android.app.Notification', 'android.app.NotificationManager'],
    harmony: {
      module: '@kit.NotificationKit (@ohos.notificationManager)',
      note:
        'NotificationCompat/NotificationManager → notificationManager.publish;渠道→NotificationSlot。' +
        '注意:优先级语义不同——Android setPriority() 是单条通知级,鸿蒙 SlotLevel 是建 NotificationSlot(渠道)时定的属性,' +
        '按渠道生效而非每次 publish 传参',
      constructs: [
        { from: 'builder.setPriority(PRIORITY_HIGH) (单条)', to: 'NotificationSlot.level = SlotLevel.LEVEL_HIGH (渠道级)' },
        { from: 'NotificationChannel', to: 'NotificationSlot' },
      ],
    },
  },
  {
    id: 'location.fine',
    kind: 'permission',
    apiPrefixes: ['android.location', 'com.google.android.gms.location'],
    harmony: {
      module: '@ohos.geoLocationManager',
      note: 'LocationManager/FusedLocation → geoLocationManager.getCurrentLocation / on("locationChange")',
    },
  },
  {
    id: 'camera',
    kind: 'permission',
    apiPrefixes: ['androidx.camera', 'android.hardware.camera2', 'android.hardware.Camera'],
    harmony: {
      module: '@ohos.multimedia.camera',
      note: 'CameraX/Camera2 → camera.getCameraManager + 会话/预览流;权限 ohos.permission.CAMERA',
    },
  },
  {
    id: 'microphone',
    kind: 'permission',
    apiPrefixes: ['android.media.MediaRecorder', 'android.media.AudioRecord'],
    harmony: {
      module: '@ohos.multimedia.audio (AudioCapturer)',
      note: 'MediaRecorder/AudioRecord → audio.createAudioCapturer;权限 ohos.permission.MICROPHONE',
    },
  },
  {
    id: 'audio.playback',
    kind: 'permission',
    apiPrefixes: ['android.media.MediaPlayer', 'androidx.media3', 'com.google.android.exoplayer2'],
    harmony: {
      module: '@ohos.multimedia.media (AVPlayer)',
      note: 'MediaPlayer/ExoPlayer/Media3 → media.createAVPlayer;数据源/状态回调重建',
    },
  },
  {
    id: 'bluetooth',
    kind: 'permission',
    apiPrefixes: ['android.bluetooth'],
    harmony: {
      module: '@ohos.bluetooth',
      note: 'BluetoothAdapter/GATT → @ohos.bluetooth.* 各子模块;权限 ohos.permission.USE_BLUETOOTH',
    },
  },
  {
    id: 'nfc',
    kind: 'permission',
    apiPrefixes: ['android.nfc'],
    harmony: {
      module: '@ohos.nfc',
      note: 'NfcAdapter → @ohos.nfc.tag / cardEmulation;权限 ohos.permission.NFC_TAG',
    },
  },
  {
    id: 'biometric',
    kind: 'permission',
    apiPrefixes: ['androidx.biometric', 'android.hardware.biometrics'],
    harmony: {
      module: '@ohos.userIAM.userAuth',
      note: 'BiometricPrompt → userAuth.getUserAuthInstance().start;权限 ohos.permission.ACCESS_BIOMETRIC',
    },
  },
  {
    id: 'vibrate',
    kind: 'permission',
    apiPrefixes: ['android.os.Vibrator', 'android.os.VibrationEffect'],
    harmony: {
      module: '@ohos.vibrator',
      note: 'Vibrator → vibrator.startVibration;权限 ohos.permission.VIBRATE',
    },
  },
  // --- Permission-only capabilities (no import prefix; target table from real
  //     samples nowinandroid + shadowsocks, E1). apiPrefixes empty: matched via
  //     AndroidManifest permission (S1), enriched with a HarmonyOS target here. ---
  {
    id: 'vpn',
    kind: 'permission',
    apiPrefixes: [],
    harmony: {
      module: '@ohos.net.vpnExtension (VpnExtensionAbility)',
      note: 'VpnService → VpnExtensionAbility + vpnExtension.setUp;权限 ohos.permission.MANAGE_VPN',
    },
  },
  {
    id: 'network.state',
    kind: 'permission',
    apiPrefixes: [],
    harmony: {
      module: '@ohos.net.connection',
      note: 'ConnectivityManager → connection.getDefaultNet / on("netAvailable");权限 ohos.permission.GET_NETWORK_INFO',
    },
  },
  {
    id: 'network.wifi',
    kind: 'permission',
    apiPrefixes: [],
    harmony: {
      module: '@ohos.wifiManager',
      note: 'WifiManager → wifiManager.getLinkedInfo / scan;权限 ohos.permission.GET_WIFI_INFO',
    },
  },
  {
    id: 'storage.read',
    kind: 'permission',
    apiPrefixes: [],
    harmony: {
      module: '@ohos.file.fs / @ohos.file.picker (DocumentViewPicker)',
      note: '读外部存储 → fileIo.open(读) 或 picker 选择文件;沙箱外访问走 picker',
    },
  },
  {
    id: 'storage.write',
    kind: 'permission',
    apiPrefixes: [],
    harmony: {
      module: '@ohos.file.fs',
      note: '写外部存储 → fileIo.open(写)+ 应用沙箱目录;跨应用共享走 filePicker/FileShare',
    },
  },
  {
    id: 'storage.media',
    kind: 'permission',
    apiPrefixes: [],
    harmony: {
      module: '@kit.MediaLibraryKit (@ohos.file.photoAccessHelper)',
      note: '读媒体库 → photoAccessHelper.getAssets / PhotoViewPicker;权限 ohos.permission.READ_IMAGEVIDEO',
    },
  },
  {
    id: 'background.foreground-service',
    kind: 'permission',
    apiPrefixes: [],
    harmony: {
      module: '@ohos.resourceschedule.backgroundTaskManager (continuousTask)',
      note: '前台服务 → backgroundTaskManager.startBackgroundRunning(长时任务);权限 ohos.permission.KEEP_BACKGROUND_RUNNING',
    },
  },
  {
    id: 'background.wakelock',
    kind: 'permission',
    apiPrefixes: [],
    harmony: {
      module: '@ohos.runningLock',
      note: 'WakeLock → runningLock.create + hold/unhold;权限 ohos.permission.RUNNING_LOCK',
    },
  },
  {
    id: 'background.boot',
    kind: 'permission',
    apiPrefixes: [],
    harmony: {
      module: '静态公共事件订阅 (@ohos.commonEventManager)',
      note: 'BOOT_COMPLETED 广播 → 静态订阅 usual.COMMON_EVENT_BOOT_COMPLETED;权限 ohos.permission.RECEIVE_STARTUP',
    },
  },
  {
    id: 'location.coarse',
    kind: 'permission',
    apiPrefixes: [],
    harmony: {
      module: '@ohos.geoLocationManager',
      note: '粗定位 → geoLocationManager.getCurrentLocation(priority:低精度);权限 ohos.permission.APPROXIMATELY_LOCATION',
    },
  },
  {
    id: 'phone.call',
    kind: 'permission',
    apiPrefixes: [],
    harmony: {
      module: '@ohos.telephony.call',
      note: '拨打电话 → call.makeCall / dial;权限 ohos.permission.PLACE_CALL',
    },
  },
  {
    id: 'phone.state',
    kind: 'permission',
    apiPrefixes: [],
    harmony: {
      module: '@ohos.telephony.observer',
      note: 'PhoneStateListener → observer.on("callStateChange");权限 ohos.permission.GET_TELEPHONY_STATE',
    },
  },
  {
    id: 'sms.send',
    kind: 'permission',
    apiPrefixes: [],
    harmony: {
      module: '@ohos.telephony.sms',
      note: 'SmsManager.sendTextMessage → sms.sendMessage;权限 ohos.permission.SEND_MESSAGES',
    },
  },
  {
    id: 'sms.receive',
    kind: 'permission',
    apiPrefixes: [],
    harmony: {
      module: '@ohos.telephony.sms',
      note: '接收短信 → 订阅短信事件;权限 ohos.permission.RECEIVE_SMS',
    },
  },
  {
    id: 'contacts.read',
    kind: 'permission',
    apiPrefixes: [],
    harmony: {
      module: '@ohos.contact',
      note: '读联系人 → contact.queryContacts;权限 ohos.permission.READ_CONTACTS',
    },
  },
  {
    id: 'contacts.write',
    kind: 'permission',
    apiPrefixes: [],
    harmony: {
      module: '@ohos.contact',
      note: '写联系人 → contact.addContact / updateContact;权限 ohos.permission.WRITE_CONTACTS',
    },
  },
];

const SPEC_BY_ID = new Map(CAPABILITY_SPECS.map((s) => [s.id, s]));

/** Longest-prefix API rules, precomputed for detection. */
const API_RULES: Array<{ prefix: string; id: string }> = CAPABILITY_SPECS.flatMap((s) =>
  s.apiPrefixes.map((prefix) => ({ prefix, id: s.id }))
).sort((a, b) => b.prefix.length - a.prefix.length);

/** The capability id an imported FQN implies, or null. */
export function apiToCapability(importFqn: string): string | null {
  for (const rule of API_RULES) {
    if (importFqn === rule.prefix || importFqn.startsWith(`${rule.prefix}.`)) return rule.id;
  }
  return null;
}

/** The HarmonyOS translation target for a capability id, or null if unknown. */
export function harmonyTargetFor(capabilityId: string): HarmonyTarget | null {
  return SPEC_BY_ID.get(capabilityId)?.harmony ?? null;
}

/**
 * HarmonyOS translation targets for Android BACKGROUND COMPONENTS (S2). Keyed
 * by the manifest component subtype — the "what does this component become on
 * the target" side of the four Android app components (activity is a Screen).
 */
const COMPONENT_TARGETS: Record<string, HarmonyTarget> = {
  service: {
    module: 'ServiceExtensionAbility / @ohos.resourceschedule.backgroundTaskManager',
    note: 'Service → 系统级用 ServiceExtensionAbility;前台服务改长时任务 backgroundTaskManager.startBackgroundRunning;纯计算后台改 TaskPool/Worker',
  },
  receiver: {
    module: '@ohos.commonEventManager',
    note: 'BroadcastReceiver → commonEventManager.subscribe(动态)/ staticSubscriber(静态,module.json5 声明)',
  },
  provider: {
    module: 'DataShareExtensionAbility (@ohos.data.dataShare)',
    note: 'ContentProvider → 跨应用共享用 DataShareExtensionAbility;应用内数据直接用 relationalStore,无需 provider',
  },
};

/** The HarmonyOS translation target for a background-component subtype, or null. */
export function harmonyComponentTargetFor(subtype: string | undefined): HarmonyTarget | null {
  return subtype ? COMPONENT_TARGETS[subtype] ?? null : null;
}

export interface CapabilityDetection {
  capabilityNodes: AppNode[];
  /** uses_capability: ArchModule → Capability. */
  edges: AppEdge[];
  /** module id → detected capability ids (for the migration-context assembly). */
  moduleCapabilities: Map<string, Set<string>>;
  stats: { capabilityCount: number; usesEdges: number; taggedModules: number };
}

/**
 * Detect capability usage from `import` nodes and tag each owning module.
 *
 * @param nodes           all code symbols
 * @param nodeToModuleId  node id → owning ArchModule id (from the M1 assignment)
 */
export function detectCapabilities(
  nodes: Node[],
  nodeToModuleId: Map<string, string>
): CapabilityDetection {
  // (moduleId, capabilityId) → evidence FQNs (bounded sample).
  const evidence = new Map<string, Set<string>>();
  const moduleCapabilities = new Map<string, Set<string>>();

  for (const node of nodes) {
    if (node.kind !== 'import') continue;
    const moduleId = nodeToModuleId.get(node.id);
    if (moduleId === undefined) continue;
    const capId = apiToCapability(node.name);
    if (capId === null) continue;

    const key = `${moduleId}\0${capId}`;
    let ev = evidence.get(key);
    if (!ev) {
      ev = new Set<string>();
      evidence.set(key, ev);
    }
    if (ev.size < 8) ev.add(node.name);

    let caps = moduleCapabilities.get(moduleId);
    if (!caps) {
      caps = new Set<string>();
      moduleCapabilities.set(moduleId, caps);
    }
    caps.add(capId);
  }

  // Capability nodes for every detected id.
  const detectedIds = new Set<string>();
  for (const key of evidence.keys()) detectedIds.add(key.slice(key.indexOf('\0') + 1));

  const capabilityNodes: AppNode[] = [...detectedIds].sort().map((id) => {
    const spec = SPEC_BY_ID.get(id)!;
    const matchKey = `capability:${id}`;
    return {
      id: makeNodeId('android', 'Capability', matchKey),
      kind: 'Capability',
      matchKey,
      name: id,
      platform: 'android',
      subtype: spec.kind,
      provenance: 'lifted',
      fidelity: 'source-project',
      confidence: 0.9,
      attrs: {
        harmonyModule: spec.harmony.module,
        harmonyNote: spec.harmony.note,
        constructs: spec.harmony.constructs ?? [],
      },
    };
  });
  const capIdToNodeId = new Map(
    capabilityNodes.map((n) => [n.matchKey.slice('capability:'.length), n.id])
  );

  // uses_capability edges: ArchModule → Capability.
  const edges: AppEdge[] = [];
  for (const [key, ev] of evidence) {
    const sep = key.indexOf('\0');
    const moduleId = key.slice(0, sep);
    const capId = key.slice(sep + 1);
    const capNodeId = capIdToNodeId.get(capId)!;
    edges.push({
      id: makeEdgeId('uses_capability', moduleId, capNodeId),
      kind: 'uses_capability',
      from: moduleId,
      to: capNodeId,
      provenance: 'lifted',
      confidence: 0.85,
      attrs: { evidence: [...ev].sort(), evidenceCount: ev.size },
    });
  }
  edges.sort((a, b) => a.id.localeCompare(b.id));

  return {
    capabilityNodes,
    edges,
    moduleCapabilities,
    stats: {
      capabilityCount: capabilityNodes.length,
      usesEdges: edges.length,
      taggedModules: moduleCapabilities.size,
    },
  };
}
