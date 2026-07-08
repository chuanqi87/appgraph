/**
 * P · app-scaffold work order.
 *
 * Locks the cross-unit aggregation: the global route table (screen → nav + the
 * unit that migrates it), the permission / deep-link / entry declarations that
 * live in one shared module.json5, and the app-level contract (deep links auto,
 * permissions + entries agent-verified). The scaffold file sorts before unit 01.
 */

import { describe, it, expect } from 'vitest';
import { MigrationPlan } from '../../src/migration/plan';
import {
  APP_SCAFFOLD_UNIT_ID,
  buildAppScaffoldContract,
  renderAppScaffoldBrief,
} from '../../src/migration/plan/scaffold';
import { ModuleBrief } from '../../src/migration/plan/context';

function moduleBrief(over: Partial<ModuleBrief>): ModuleBrief {
  return {
    moduleId: 'm', moduleName: ':feature', publicInterface: [], capabilities: [],
    dependencies: [], impliedDependencies: [], screens: [], dataModels: [],
    permissionCapabilities: [], backgroundComponents: [], appEntries: [], deeplinks: [],
    ...over,
  };
}

function planWith(modules: ModuleBrief[]): MigrationPlan {
  return {
    schemaVersion: 3,
    source: { platform: 'android', app: { name: 't', packageName: 'c' } },
    target: undefined,
    planning: { enabled: true, minUnitSymbols: 120, maxUnitSymbols: 3000, merged: 0, split: 0 },
    totalUnits: 1,
    appScaffold: { briefFile: 'units/00-app-scaffold.md', contractFile: 'contracts/00-app-scaffold.json' },
    units: [
      {
        id: 'u1', order: 0, label: ':feature', kind: 'module', cyclic: false,
        moduleIds: ['m'], symbolCount: 10, briefFile: 'units/01-feature.md',
        contractFile: 'contracts/01-feature.json', modules,
      },
    ],
  } as unknown as MigrationPlan;
}

const plan = planWith([
  moduleBrief({
    screens: [
      { name: 'HomeScreen', navigatesTo: ['DetailScreen'], layouts: [] },
      { name: 'DetailScreen', navigatesTo: [], layouts: [] },
    ],
    appEntries: ['MainActivity'],
    deeplinks: ['myapp://open'],
    permissionCapabilities: ['location', 'notification'],
    dataModels: [{ name: 'Topic', subtype: 'entity', fields: [] }],
  }),
]);

describe('renderAppScaffoldBrief', () => {
  it('renders the global route table, entries, deep links and permissions', () => {
    const md = renderAppScaffoldBrief(plan);
    expect(md).toContain('# 迁移工单 00 · 应用装配 (app scaffold)');
    expect(md).toContain('HomeScreen(:feature · 单元 1) → DetailScreen');
    expect(md).toContain('启动入口:MainActivity');
    expect(md).toContain('深链:myapp://open');
    expect(md).toContain('location, notification');
    expect(md).toContain('Topic(:feature)');
  });
});

describe('buildAppScaffoldContract', () => {
  it('emits deep-link (auto), permission + entry (agent) checks under module "app"', () => {
    const contract = buildAppScaffoldContract(plan);
    expect(contract.unitId).toBe(APP_SCAFFOLD_UNIT_ID);
    const kinds = contract.checks.map((c) => `${c.kind}:${c.verify}`).sort();
    expect(kinds).toEqual([
      'background:agent', // MainActivity entry
      'capability:agent', // location
      'capability:agent', // notification
      'deeplink:auto', // myapp://open
    ]);
    expect(contract.checks.every((c) => c.moduleId === 'app')).toBe(true);
  });
});

describe('scaffold file ordering', () => {
  it('sorts before unit 01', () => {
    expect(plan.appScaffold.briefFile).toBe('units/00-app-scaffold.md');
    expect('00-app-scaffold' < '01-feature').toBe(true);
  });
});
