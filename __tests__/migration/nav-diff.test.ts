/**
 * L2 · navigation topology diff.
 *
 * `diffNavigation` splits source edges into matched / missing-edge / endpoint-
 * missing (the last belongs to the V1 screen gap, never double-counted here).
 * Target-side route-literal recovery (`pushUrl`/`pushPath` → nav edge) is covered
 * end-to-end in `target-graph.test.ts` against a real community index.
 */

import { describe, it, expect } from 'vitest';
import { diffNavigation } from '../../src/migration/verify/structure-diff';

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
