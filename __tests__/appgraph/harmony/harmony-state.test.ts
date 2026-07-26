/**
 * U3 · DataModel — AppStorageV2 / PersistenceV2 global state models.
 *
 * HarmonyOS binds shared state by TYPE (`connect(GlobalState, key, factory)`),
 * so the data-model layer is only visible if `@ObservedV2` survives extraction
 * and the type argument resolves. Both are asserted here, plus the precise-or-drop
 * rule for a type that isn't an observed model.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeGraph } from '../../../src/index';
import { CodeSymbolGraph } from '../../../src/appgraph/graph-reader';
import { detectHarmonyState } from '../../../src/appgraph/detect/harmony-state';
import { extractHarmonyModuleSkeleton } from '../../../src/appgraph/modules/harmony-ext';
import type { AppNode } from '../../../src/appgraph/schema';
import type { Node } from '../../../src/types';

const FIXTURE = join(__dirname, '../../fixtures/harmony-navigation-multi');

let root: string;
let models: AppNode[];
let warnings: string[];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'harmony-state-'));
  cpSync(FIXTURE, root, { recursive: true });
  const cg = await CodeGraph.init(root, { index: true });
  cg.close();

  const reader = CodeSymbolGraph.open(root);
  try {
    const cache = new Map<string, string | null>();
    const readCode = (n: Node): string | null => {
      if (!cache.has(n.id)) cache.set(n.id, reader.getCode(n));
      return cache.get(n.id)!;
    };
    const modules = extractHarmonyModuleSkeleton(root).nodes.map((n) => ({
      id: n.id,
      name: n.name,
      dir: n.attrs!.dir as string,
    }));
    const result = detectHarmonyState(reader, readCode, modules);
    models = result.dataModelNodes;
    warnings = result.warnings.map((w) => w.message);
  } finally {
    reader.close();
  }
}, 120_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('@ObservedV2 survives extraction', () => {
  it('recovers a DataModel for each connected observed class', () => {
    expect(models.map((m) => m.name).sort()).toEqual(['CurrentCity', 'GlobalState']);
  });

  it('records @Trace fields as the model schema', () => {
    const global = models.find((m) => m.name === 'GlobalState')!;
    // `internalCounter` is untraced — not part of the observed schema.
    expect(global.attrs!.fields).toEqual(['activeTabId', 'isLoggedIn']);
  });
});

describe('state key resolution', () => {
  it('defaults the key to the type name in the 2-arg form', () => {
    const global = models.find((m) => m.name === 'GlobalState')!;
    expect(global.attrs!.stateKeys).toEqual(['GlobalState']);
  });

  it('back-resolves a constant key through the enum index', () => {
    // `PersistenceV2.connect(CurrentCity, AppStorageMap.CURRENT_CITY, …)`
    const city = models.find((m) => m.name === 'CurrentCity')!;
    expect(city.attrs!.stateKeys).toEqual(['currentCity']);
  });
});

describe('memory vs persisted', () => {
  it('distinguishes AppStorageV2 from PersistenceV2', () => {
    // The distinction a migration must preserve: one survives restarts.
    expect(models.find((m) => m.name === 'GlobalState')!.subtype).toBe('app-storage');
    expect(models.find((m) => m.name === 'CurrentCity')!.subtype).toBe('persistence');
  });
});

describe('precise-or-drop', () => {
  it('emits NO model for a type that is not an @ObservedV2 class', () => {
    expect(models.some((m) => m.name === 'NotObservedModel')).toBe(false);
  });

  it('warns about the unresolved type instead of dropping it silently', () => {
    expect(warnings.some((w) => w.includes('NotObservedModel'))).toBe(true);
  });

  it('ignores an observed-looking class that is never connected', () => {
    expect(models.some((m) => m.name === 'PlainHelper')).toBe(false);
  });
});
