/**
 * S1 · permission → capability from AndroidManifest.
 *
 * Locks the phase-2 acceptance criterion: manifest permissions (POST_NOTIFICATIONS,
 * CAMERA, …) become source-side `capability:<id>` nodes attributed to their owning
 * ArchModule, deterministically, with build-output and test source-sets excluded.
 * A conditional test runs the detector against the real nowinandroid sample.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  detectManifestCapabilities,
  ModuleRef,
} from '../../src/migration/detect/manifest-capabilities';

function writeManifest(root: string, rel: string, permissions: string[]): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const uses = permissions
    .map((p) => `  <uses-permission android:name="${p}" />`)
    .join('\n');
  fs.writeFileSync(
    full,
    `<manifest package="com.example">\n${uses}\n  <application/>\n</manifest>\n`,
    'utf8'
  );
}

function mkTemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mig-manifest-'));
}

describe('S1 · manifest permission → capability', () => {
  it('maps permissions to capabilities and attributes them to owning modules', () => {
    const root = mkTemp();
    try {
      writeManifest(root, 'core/notifications/src/main/AndroidManifest.xml', [
        'android.permission.POST_NOTIFICATIONS',
      ]);
      writeManifest(root, 'feature/camera/src/main/AndroidManifest.xml', [
        'android.permission.CAMERA',
        'android.permission.RECORD_AUDIO',
      ]);
      const modules: ModuleRef[] = [
        { id: 'm-notif', name: ':core:notifications', dir: 'core/notifications' },
        { id: 'm-cam', name: ':feature:camera', dir: 'feature/camera' },
      ];

      const r = detectManifestCapabilities(root, modules);
      const capIds = r.capabilityNodes.map((n) => n.name).sort();
      expect(capIds).toEqual(['camera', 'microphone', 'notification']);

      // Each capability is attributed to its owning module via a uses_capability edge.
      const notifCap = r.capabilityNodes.find((n) => n.name === 'notification')!;
      expect(r.usesEdges.some((e) => e.from === 'm-notif' && e.to === notifCap.id)).toBe(true);
      const camCap = r.capabilityNodes.find((n) => n.name === 'camera')!;
      expect(r.usesEdges.some((e) => e.from === 'm-cam' && e.to === camCap.id)).toBe(true);

      // Capabilities with a HarmonyOS target are enriched (translation anchor).
      expect(notifCap.attrs?.harmonyModule).toContain('notificationManager');
      expect(camCap.attrs?.harmonyModule).toContain('camera');

      // Manifest facts are confidence 1, provenance manifest.
      expect(notifCap.provenance).toBe('manifest');
      expect(notifCap.confidence).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('excludes build output and test source sets; is deterministic', () => {
    const root = mkTemp();
    try {
      writeManifest(root, 'app/src/main/AndroidManifest.xml', [
        'android.permission.ACCESS_FINE_LOCATION',
      ]);
      // Build output — must be ignored (merged manifests over-declare permissions).
      writeManifest(root, 'app/build/intermediates/merged/AndroidManifest.xml', [
        'android.permission.CAMERA',
      ]);
      // Test source set — must be ignored.
      writeManifest(root, 'app/src/androidTest/AndroidManifest.xml', [
        'android.permission.BLUETOOTH',
      ]);
      const modules: ModuleRef[] = [{ id: 'm-app', name: ':app', dir: 'app' }];

      const r1 = detectManifestCapabilities(root, modules);
      const r2 = detectManifestCapabilities(root, modules);
      expect(r1.capabilityNodes.map((n) => n.name)).toEqual(['location.fine']);
      // Determinism: identical node/edge ids across runs.
      expect(r1.capabilityNodes.map((n) => n.id)).toEqual(r2.capabilityNodes.map((n) => n.id));
      expect(r1.usesEdges.map((e) => e.id)).toEqual(r2.usesEdges.map((e) => e.id));
      expect(r1.stats.manifestCount).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('surfaces unmapped permissions as coverage warnings, never silently drops', () => {
    const root = mkTemp();
    try {
      writeManifest(root, 'app/src/main/AndroidManifest.xml', [
        'android.permission.ACCESS_ADSERVICES_AD_ID', // unmapped
      ]);
      const r = detectManifestCapabilities(root, [{ id: 'm', name: ':app', dir: 'app' }]);
      expect(r.capabilityNodes).toHaveLength(0);
      expect(r.permissionNodes).toHaveLength(1);
      expect(r.warnings.some((w) => w.message.includes('ACCESS_ADSERVICES_AD_ID'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('S1 · against nowinandroid (when present)', () => {
  const sample = findSample('nowinandroid');
  it.runIf(sample)('detects POST_NOTIFICATIONS → notification from real source manifests', () => {
    const modules: ModuleRef[] = [
      { id: 'm-notif', name: ':core:notifications', dir: 'core/notifications' },
      { id: 'm-net', name: ':core:network', dir: 'core/network' },
      { id: 'm-data', name: ':core:data', dir: 'core/data' },
      { id: 'm-app', name: ':app', dir: 'app' },
    ];
    const r = detectManifestCapabilities(sample!, modules);
    const caps = r.capabilityNodes.map((n) => n.name);
    // notification is a verifiable spec — this is the phase-2 acceptance criterion.
    expect(caps).toContain('notification');
    expect(caps).toContain('internet');
    // Attributed to the module whose manifest declared it.
    const notif = r.capabilityNodes.find((n) => n.name === 'notification')!;
    expect(r.usesEdges.some((e) => e.from === 'm-notif' && e.to === notif.id)).toBe(true);
    // Build-output manifests (which over-declare WAKE_LOCK etc.) are excluded.
    expect(caps).not.toContain('background.wakelock');
  });
});

function findSample(name: string): string | null {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'references', 'samples', name);
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}
