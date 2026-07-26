/**
 * HarmonyOS project model + M1 module graph.
 *
 * The two rules under test are the ones that break module counts in the wild:
 * root discovery must key on `AppScope/` (not the build file), and the module
 * inventory must come from the root `build-profile.json5` (not a tree walk).
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  isHarmonyProjectRoot,
  loadHarmonyProject,
} from '../../../src/appgraph/extractors/harmony/project';
import {
  extractHarmonyModuleSkeleton,
  classifyHarmonyModule,
  resolveRelativeModuleDir,
} from '../../../src/appgraph/modules/harmony-ext';

const FIXTURE = join(__dirname, '../../fixtures/harmony-navigation-multi');

describe('project root discovery', () => {
  it('recognizes a root by AppScope/app.json5', () => {
    expect(isHarmonyProjectRoot(FIXTURE)).toBe(true);
  });

  it('does NOT treat ohpm_custom_dependency/ as a root (it has a build-profile but no AppScope)', () => {
    // Rooting on build-profile.json5 double-counts vendored mirrors — the bug
    // that turns WebShortDrama's 32 modules into 64.
    expect(isHarmonyProjectRoot(join(FIXTURE, 'ohpm_custom_dependency'))).toBe(false);
  });

  it('returns null for a non-HarmonyOS directory', () => {
    expect(loadHarmonyProject(join(FIXTURE, 'commons'))).toBeNull();
  });
});

describe('module inventory', () => {
  const project = loadHarmonyProject(FIXTURE)!;

  it('takes the module list from the root build-profile, not a tree walk', () => {
    expect(project.modules.map((m) => m.name).sort()).toEqual([
      'entry',
      'feedback',
      'lib_foundation',
      'order',
    ]);
  });

  it('excludes the vendored mirror and oh_modules copies', () => {
    const dirs = project.modules.map((m) => m.dir);
    expect(dirs.some((d) => d.includes('ohpm_custom_dependency'))).toBe(false);
    expect(dirs.some((d) => d.includes('oh_modules'))).toBe(false);
  });

  it('excludes src/ohosTest/module.json5 (would double every module count)', () => {
    expect(project.modules.every((m) => m.type !== 'feature')).toBe(true);
    expect(project.modules.some((m) => m.name.endsWith('_test'))).toBe(false);
  });

  it('reads bundleName from AppScope even with comments and trailing commas', () => {
    expect(project.bundleName).toBe('com.example.navdemo');
    expect(project.atomicService).toBe(false);
  });

  it('records each module type from its own module.json5', () => {
    const byName = new Map(project.modules.map((m) => [m.name, m]));
    expect(byName.get('entry')!.type).toBe('entry');
    expect(byName.get('order')!.type).toBe('har');
    expect(byName.get('feedback')!.type).toBe('shared');
  });
});

describe('M1 module skeleton', () => {
  const skeleton = extractHarmonyModuleSkeleton(FIXTURE);
  const idToName = new Map(skeleton.nodes.map((n) => [n.id, n.name]));
  const edgeNames = skeleton.edges
    .map((e) => `${idToName.get(e.from)}→${idToName.get(e.to)}`)
    .sort();

  it('emits one ArchModule per declared module', () => {
    expect(skeleton.nodes).toHaveLength(4);
    expect(skeleton.nodes.every((n) => n.kind === 'ArchModule')).toBe(true);
    expect(skeleton.nodes.every((n) => n.platform === 'harmony')).toBe(true);
  });

  it('recovers dependency edges from an oh-package with unquoted keys AND single quotes', () => {
    // The silent-loss regression: before the JSON5 reader these three vanished.
    expect(edgeNames).toEqual([
      'entry→feedback',
      'entry→lib_foundation',
      'entry→order',
      'feedback→lib_foundation',
      'order→lib_foundation',
    ]);
  });

  it('marks declared dependencies as manifest-grade (confidence 1)', () => {
    expect(skeleton.edges.every((e) => e.provenance === 'manifest' && e.confidence === 1)).toBe(
      true
    );
  });

  it('carries the bundleName as the package name', () => {
    expect(skeleton.packageName).toBe('com.example.navdemo');
  });

  it('exposes module dirs for node assignment', () => {
    expect(skeleton.moduleDirs).toEqual([
      'commons/lib_foundation',
      'components/feedback',
      'features/order',
      'products/entry',
    ]);
  });

  it('warns instead of silently returning an empty graph for a non-HarmonyOS root', () => {
    const bad = extractHarmonyModuleSkeleton(join(FIXTURE, 'commons'));
    expect(bad.nodes).toHaveLength(0);
    expect(bad.warnings.length).toBeGreaterThan(0);
    expect(bad.warnings[0]!.message).toContain('AppScope');
  });
});

describe('module classification', () => {
  it('derives role from the four-directory convention', () => {
    const mk = (dir: string, name: string, type: string | null) =>
      classifyHarmonyModule({
        name,
        dir,
        type,
        manifest: null,
        ohPackage: null,
        appliesToProducts: [],
      });

    expect(mk('products/entry', 'entry', 'entry').role).toBe('app');
    expect(mk('features/order', 'order', 'har').role).toBe('feature');
    expect(mk('commons/lib_foundation', 'lib_foundation', 'har').role).toBe('core');
    expect(mk('components/feedback', 'feedback', 'har').role).toBe('component');
    expect(mk('third/whatever', 'whatever', 'har').role).toBe('library');
  });

  it('falls back to module type when the layout deviates', () => {
    const r = classifyHarmonyModule({
      name: 'app',
      dir: 'somewhere/app',
      type: 'entry',
      manifest: null,
      ohPackage: null,
      appliesToProducts: [],
    });
    expect(r.role).toBe('app');
  });

  it('marks test-support modules dev-only', () => {
    const r = classifyHarmonyModule({
      name: 'test_utils',
      dir: 'commons/test_utils',
      type: 'har',
      manifest: null,
      ohPackage: null,
      appliesToProducts: [],
    });
    expect(r.necessity).toBe('dev-only');
  });
});

describe('resolveRelativeModuleDir', () => {
  it('resolves a file: target against the declaring module dir', () => {
    expect(resolveRelativeModuleDir('products/entry', '../../features/order')).toBe(
      'features/order'
    );
    expect(resolveRelativeModuleDir('features/order', './libs/sdk')).toBe('features/order/libs/sdk');
    expect(resolveRelativeModuleDir('a/b/c', '../../..')).toBe('');
  });
});
