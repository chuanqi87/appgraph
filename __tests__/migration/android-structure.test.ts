/**
 * S2 · Android structural facts (manifest components + intent navigation +
 * layout hosting).
 *
 * Locks the phase-4 acceptance criteria: the manifest's Screen(activity)/
 * BackgroundComponent/AppEntry/Resource(deeplink) nodes reach the migration
 * graph (S1 used to drop them), explicit-intent navigation and startService
 * backing edges are lifted from source, screens link to the xml layouts they
 * host, and the whole pass is deterministic.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectAndroidStructure } from '../../src/appgraph/detect/android-structure';
import { ModuleRef } from '../../src/appgraph/detect/manifest-capabilities';
import { makeNodeId, screenMatchKey } from '../../src/appgraph/schema';

const MANIFEST = `<manifest package="com.example.app">
  <application>
    <activity android:name=".MainActivity" android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.MAIN"/>
        <category android:name="android.intent.category.LAUNCHER"/>
      </intent-filter>
      <intent-filter>
        <action android:name="android.intent.action.VIEW"/>
        <category android:name="android.intent.category.BROWSABLE"/>
        <data android:scheme="myapp" android:host="open"/>
      </intent-filter>
    </activity>
    <activity android:name=".DetailActivity"/>
    <service android:name=".SyncService" android:foregroundServiceType="dataSync"/>
    <receiver android:name=".BootReceiver"/>
    <provider android:name=".DataProvider"/>
  </application>
</manifest>
`;

const MAIN_ACTIVITY = `package com.example.app

class MainActivity : AppCompatActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(R.layout.activity_main)
    startActivity(Intent(this, DetailActivity::class.java))
    startService(Intent(this, SyncService::class.java))
  }
}
`;

function write(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

function mkProject(): { root: string; modules: ModuleRef[]; layoutIds: Set<string> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-structure-'));
  write(root, 'app/src/main/AndroidManifest.xml', MANIFEST);
  write(root, 'app/src/main/java/com/example/app/MainActivity.kt', MAIN_ACTIVITY);
  const modules: ModuleRef[] = [{ id: 'm-app', name: ':app', dir: 'app' }];
  // The xml-layout Screen id U6 would produce for res/layout/activity_main.xml.
  const layoutIds = new Set([
    makeNodeId('android', 'Screen', screenMatchKey('layout_activity_main')),
  ]);
  return { root, modules, layoutIds };
}

describe('S2 · android structure detect', () => {
  it('keeps the manifest structural nodes S1 drops, with module attribution', () => {
    const { root, modules, layoutIds } = mkProject();
    try {
      const r = detectAndroidStructure(root, modules, layoutIds);

      const byKind = (kind: string) => r.nodes.filter((n) => n.kind === kind);
      expect(byKind('Screen').map((n) => n.name).sort()).toEqual([
        'DetailActivity',
        'MainActivity',
      ]);
      expect(byKind('BackgroundComponent').map((n) => n.name).sort()).toEqual([
        'BootReceiver',
        'DataProvider',
        'SyncService',
      ]);
      expect(byKind('AppEntry')).toHaveLength(1);
      expect(byKind('Resource').map((n) => n.name)).toEqual(['myapp://open']);

      // Every manifest component is attributed to its owning module.
      const main = byKind('Screen').find((n) => n.name === 'MainActivity')!;
      expect(
        r.edges.some(
          (e) => e.kind === 'app_contains' && e.from === 'm-app' && e.to === main.id
        )
      ).toBe(true);

      // Deep link is exposed by the screen that declares its intent-filter.
      const deeplink = byKind('Resource')[0]!;
      expect(
        r.edges.some((e) => e.kind === 'exposes' && e.from === main.id && e.to === deeplink.id)
      ).toBe(true);

      expect(r.stats.activityScreens).toBe(2);
      expect(r.stats.backgroundComponents).toBe(3);
      expect(r.stats.appEntries).toBe(1);
      expect(r.stats.deeplinks).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('enriches components with HarmonyOS targets and lifts the foreground-service capability', () => {
    const { root, modules, layoutIds } = mkProject();
    try {
      const r = detectAndroidStructure(root, modules, layoutIds);

      const service = r.nodes.find((n) => n.name === 'SyncService')!;
      expect(String(service.attrs?.harmonyModule)).toContain('ServiceExtensionAbility');
      const receiver = r.nodes.find((n) => n.name === 'BootReceiver')!;
      expect(String(receiver.attrs?.harmonyModule)).toContain('commonEventManager');
      const provider = r.nodes.find((n) => n.name === 'DataProvider')!;
      expect(String(provider.attrs?.harmonyModule)).toContain('DataShareExtensionAbility');

      // foregroundServiceType → auto-verifiable module capability, fully enriched.
      const caps = r.nodes.filter((n) => n.kind === 'Capability');
      expect(caps.map((n) => n.name)).toEqual(['background.foreground-service']);
      expect(String(caps[0]!.attrs?.harmonyModule)).toContain('backgroundTaskManager');
      expect(
        r.edges.some(
          (e) => e.kind === 'uses_capability' && e.from === 'm-app' && e.to === caps[0]!.id
        )
      ).toBe(true);

      // S1's territory stays untouched: no Permission nodes without a
      // requires_permission edge, no permission-derived capabilities.
      expect(r.nodes.filter((n) => n.kind === 'Permission')).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('no longer scans navigation from source — nav/backed_by are lifted from the core graph', () => {
    const { root, modules, layoutIds } = mkProject();
    try {
      const r = detectAndroidStructure(root, modules, layoutIds);

      // The manifest Screens/components are still produced here.
      expect(r.nodes.some((n) => n.kind === 'Screen' && n.name === 'MainActivity')).toBe(true);
      expect(r.nodes.some((n) => n.kind === 'Screen' && n.name === 'DetailActivity')).toBe(true);

      // navigates_to / backed_by are no longer string-scanned here — the intent
      // flow is lifted from the core android-intent synthesized edges
      // (lift/navigates-from-core, covered by __tests__/appgraph-navigation-lift.test.ts).
      expect(r.edges.some((e) => e.kind === 'navigates_to')).toBe(false);
      expect(r.edges.some((e) => e.kind === 'backed_by')).toBe(false);
      expect(r.stats.intentNavEdges).toBe(0);
      expect(r.stats.backedByEdges).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('links a screen to the xml layout it hosts, only for layouts U6 produced', () => {
    const { root, modules, layoutIds } = mkProject();
    try {
      const r = detectAndroidStructure(root, modules, layoutIds);
      const main = r.nodes.find((n) => n.kind === 'Screen' && n.name === 'MainActivity')!;
      const layoutId = [...layoutIds][0]!;
      const hosted = r.edges.find(
        (e) => e.kind === 'app_contains' && e.attrs?.via === 'set-content-view'
      )!;
      expect(hosted.from).toBe(main.id);
      expect(hosted.to).toBe(layoutId);
      expect(r.stats.layoutLinks).toBe(1);

      // Unknown layout → no dangling edge.
      const none = detectAndroidStructure(root, modules, new Set());
      expect(none.stats.layoutLinks).toBe(0);
      expect(
        none.edges.some((e) => e.attrs?.via === 'set-content-view')
      ).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('discovers a ViewBinding fragment as a screen and links its layout', () => {
    const { root, modules, layoutIds } = mkProject();
    const briefLayoutId = makeNodeId('android', 'Screen', screenMatchKey('layout_brief_contact'));
    layoutIds.add(briefLayoutId);
    write(
      root,
      'app/src/main/java/com/example/app/BriefContactFragment.kt',
      `package com.example.app
class BriefContactFragment : Fragment() {
  private val binding by lazy { BriefContactBinding.inflate(layoutInflater) }
}
`
    );
    try {
      const r = detectAndroidStructure(root, modules, layoutIds);
      const fragment = r.nodes.find((n) => n.name === 'BriefContactFragment')!;
      expect(fragment.kind).toBe('Screen');
      expect(fragment.subtype).toBe('fragment');
      expect(fragment.attrs?.discoveredBy).toBe('layout-binding');
      // Owned by its module AND hosting the binding-derived layout.
      expect(
        r.edges.some((e) => e.kind === 'app_contains' && e.from === 'm-app' && e.to === fragment.id)
      ).toBe(true);
      const hosts = r.edges.find(
        (e) => e.kind === 'app_contains' && e.from === fragment.id && e.to === briefLayoutId
      )!;
      expect(hosts.attrs?.via).toBe('view-binding');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('is deterministic: two runs produce byte-identical output', () => {
    const { root, modules, layoutIds } = mkProject();
    try {
      const a = detectAndroidStructure(root, modules, layoutIds);
      const b = detectAndroidStructure(root, modules, layoutIds);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
