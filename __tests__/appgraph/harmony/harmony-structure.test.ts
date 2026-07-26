/**
 * S2 · `module.json5` → structural nodes, and M3b → permission capabilities.
 *
 * These are the manifest-grade facts (confidence 1) the rest of the graph hangs
 * off: the launcher entry, background components, deep links, and the
 * permission → capability normalization that makes cross-platform diffing work.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { loadHarmonyProject } from '../../../src/appgraph/extractors/harmony/project';
import { extractHarmonyManifest } from '../../../src/appgraph/extractors/harmony/manifest';
import { detectHarmonyStructure } from '../../../src/appgraph/detect/harmony-structure';
import { detectHarmonyManifests } from '../../../src/appgraph/detect/harmony-manifest-capabilities';
import { extractHarmonyModuleSkeleton } from '../../../src/appgraph/modules/harmony-ext';
import { harmonyPermissionToCapability } from '../../../src/appgraph/extractors/harmony/capabilities';
import { androidPermissionToCapability } from '../../../src/appgraph/extractors/android/capabilities';
import type { ModuleRef } from '../../../src/appgraph/detect/manifest-capabilities';

const FIXTURE = join(__dirname, '../../fixtures/harmony-navigation-multi');

function moduleRefs(): ModuleRef[] {
  return extractHarmonyModuleSkeleton(FIXTURE).nodes.map((n) => ({
    id: n.id,
    name: n.name,
    dir: n.attrs!.dir as string,
  }));
}

describe('manifest → structural nodes', () => {
  const project = loadHarmonyProject(FIXTURE)!;
  const result = detectHarmonyStructure(project, moduleRefs());
  const byKind = (k: string) => result.nodes.filter((n) => n.kind === k);

  it('promotes the mainElement ability to AppEntry', () => {
    const entries = byKind('AppEntry');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe('EntryAbility');
    expect(entries[0]!.subtype).toBe('ability');
    expect(entries[0]!.confidence).toBe(1);
    expect(entries[0]!.provenance).toBe('manifest');
  });

  it('points AppEntry at the srcEntry code file, not the manifest', () => {
    // The Ability→code link is what later phases hang the first-screen edge off.
    expect(byKind('AppEntry')[0]!.platformRef!.file).toBe(
      'products/entry/src/main/ets/entryability/EntryAbility.ets'
    );
  });

  it('records an extensionAbility as a BackgroundComponent typed by its extension kind', () => {
    const bg = byKind('BackgroundComponent');
    expect(bg).toHaveLength(1);
    expect(bg[0]!.name).toBe('EntryFormAbility');
    // `form` = home-screen widget ≈ AppWidgetProvider.
    expect(bg[0]!.subtype).toBe('form');
  });

  it('lifts skills[].uris to a deep-link Resource with an exposes edge', () => {
    const res = byKind('Resource');
    expect(res).toHaveLength(1);
    expect(res[0]!.subtype).toBe('deep-link');
    expect(res[0]!.attrs).toMatchObject({
      scheme: 'https',
      host: 'nav.example.cn',
      pathRegex: '\\b(order|home)\\b',
      domainVerify: true,
    });

    const exposes = result.edges.filter((e) => e.kind === 'exposes');
    expect(exposes).toHaveLength(1);
    expect(exposes[0]!.from).toBe(byKind('AppEntry')[0]!.id);
    expect(exposes[0]!.to).toBe(res[0]!.id);
  });

  it('attributes every structural node to its owning module', () => {
    const contains = result.edges.filter((e) => e.kind === 'app_contains');
    const structuralIds = new Set(result.nodes.map((n) => n.id));
    expect(contains).toHaveLength(result.nodes.length);
    expect(contains.every((e) => structuralIds.has(e.to))).toBe(true);
  });

  it('does not emit a launcher entry for HAR/HSP modules', () => {
    // Only `entry` declares abilities; har/shared modules contribute none.
    expect(byKind('AppEntry')).toHaveLength(1);
  });
});

describe('manifest → permissions and capabilities', () => {
  const caps = detectHarmonyManifests(FIXTURE, moduleRefs());

  it('emits one Permission node per requestPermissions entry', () => {
    expect(caps.permissionNodes.map((n) => n.name).sort()).toEqual([
      'ohos.permission.CAMERA',
      'ohos.permission.INTERNET',
      'ohos.permission.READ_CALENDAR',
    ]);
  });

  it('normalizes permissions onto the SAME capability ids Android uses', () => {
    const ids = caps.capabilityNodes.map((n) => n.name).sort();
    expect(ids).toEqual(['camera', 'internet']);
    // The cross-platform anchor: both platforms land on `camera`.
    expect(harmonyPermissionToCapability('ohos.permission.CAMERA')).toBe(
      androidPermissionToCapability('android.permission.CAMERA')
    );
  });

  it('warns for an unmapped permission instead of dropping it silently', () => {
    // READ_CALENDAR has no id in the neutral vocabulary yet — the gap must be
    // visible, never an invented capability nor silence.
    expect(harmonyPermissionToCapability('ohos.permission.READ_CALENDAR')).toBeNull();
    expect(caps.warnings.some((w) => w.message.includes('READ_CALENDAR'))).toBe(true);
  });

  it('wires uses_capability from the declaring module at confidence 1', () => {
    expect(caps.usesEdges.length).toBe(caps.capabilityNodes.length);
    expect(caps.usesEdges.every((e) => e.provenance === 'manifest' && e.confidence === 1)).toBe(
      true
    );
  });

  it('parses single-quoted permission entries (dirty JSON5)', () => {
    // `"name": 'ohos.permission.CAMERA'` — the CarBeautyCare shape.
    expect(caps.permissionNodes.some((n) => n.name === 'ohos.permission.CAMERA')).toBe(true);
  });
});

describe('anti-silence', () => {
  it('flags a project whose manifests yield no app entry at all', () => {
    const project = loadHarmonyProject(FIXTURE)!;
    // Strip abilities from every module — simulates unreadable/《missing》manifests.
    const stripped = {
      ...project,
      modules: project.modules.map((m) => ({
        ...m,
        manifest: m.manifest ? { ...m.manifest, abilities: [], mainElement: undefined } : null,
      })),
    };
    const result = detectHarmonyStructure(stripped, moduleRefs());
    expect(result.stats.appEntries).toBe(0);
    expect(result.warnings.some((w) => w.message.includes('入口'))).toBe(true);
  });

  it('a module with no manifest contributes nothing rather than throwing', () => {
    const extraction = extractHarmonyManifest({
      name: 'x',
      dir: 'features/x',
      type: null,
      manifest: null,
      ohPackage: null,
      appliesToProducts: [],
    });
    expect(extraction.nodes).toEqual([]);
    expect(extraction.edges).toEqual([]);
  });
});
