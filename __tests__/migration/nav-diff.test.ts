/**
 * L2 · navigation topology diff.
 *
 * Locks: the ArkTS page scanner recovers BOTH router forms (pushUrl `pages/X`
 * and NavPathStack pushPath(ByName)), `parseGeneratedTarget` no longer discards
 * the recovered edges (regression pin), and `diffNavigation` splits source edges
 * into matched / missing-edge / endpoint-missing (the last belongs to the V1
 * screen gap, never double-counted here).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanArktsPage } from '../../src/migration/extractors/harmony/pages';
import { parseGeneratedTarget } from '../../src/migration/verify/parse-ets';
import { diffNavigation } from '../../src/migration/verify/structure-diff';

describe('scanArktsPage', () => {
  it('recovers pushUrl and pushPath(ByName) targets from the @Entry struct', () => {
    const src = [
      '@Entry @Component struct HomePage {',
      '  build() {',
      "    router.pushUrl({ url: 'pages/DetailPage' })",
      "    this.stack.pushPathByName('SettingsPage', null)",
      "    this.stack.pushPath({ name: 'ignored-object-form' })",
      '  }',
      '}',
    ].join('\n');
    const page = scanArktsPage('Home.ets', src);
    expect(page.screen?.name).toBe('HomePage');
    expect(page.navTargets).toEqual(['DetailPage', 'SettingsPage']);
  });
});

describe('parseGeneratedTarget navEdges (regression: no longer discarded)', () => {
  let root = '';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'navedge-'));
    mkdirSync(join(root, 'pages'), { recursive: true });
    writeFileSync(
      join(root, 'pages/HomePage.ets'),
      "@Entry @Component struct HomePage { build() { router.pushUrl({ url: 'pages/DetailPage' }) } }\n"
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('exposes router edges from @Entry struct → routed page', () => {
    const parse = parseGeneratedTarget(root);
    expect(parse.navEdges).toEqual([{ from: 'HomePage', to: 'DetailPage' }]);
  });
});

describe('diffNavigation', () => {
  it('splits edges into matched / missing / endpoint-missing', () => {
    const source = [
      { from: 'HomeScreen', to: 'DetailScreen' }, // aligns to target home→detail
      { from: 'HomeScreen', to: 'SettingsScreen' }, // both screens exist, edge absent
      { from: 'HomeScreen', to: 'GhostScreen' }, // GhostScreen missing → V1 gap
    ];
    const target = [{ from: 'HomePage', to: 'DetailPage' }];
    const targetScreens = ['HomePage', 'DetailPage', 'SettingsPage'];

    const diff = diffNavigation(source, target, targetScreens);
    expect(diff.matched).toEqual([{ from: 'HomeScreen', to: 'DetailScreen' }]);
    expect(diff.missingInTarget).toEqual([{ from: 'HomeScreen', to: 'SettingsScreen' }]);
    expect(diff.skippedEndpointMissing).toEqual([{ from: 'HomeScreen', to: 'GhostScreen' }]);
    expect(diff.sourceCount).toBe(3);
  });
});
