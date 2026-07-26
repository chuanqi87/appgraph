/**
 * `harmony-nav` — HarmonyOS Navigation route synthesis, end to end.
 *
 * Runs a real index over the multi-module fixture, because the value of this
 * family is precisely that it survives the real pipeline: route table → enum
 * back-resolution → page struct, across module boundaries.
 *
 * The negative cases matter as much as the positive ones. A wrong navigation
 * edge is worse than a missing one, so a runtime-computed route name must
 * produce NOTHING rather than a plausible guess.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeGraph } from '../src/index';
import { CodeSymbolGraph } from '../src/appgraph/graph-reader';
import type { SynthesizedEdge } from '../src/appgraph/graph-reader';
import type { Node } from '../src/types';

const FIXTURE = join(__dirname, 'fixtures/harmony-navigation-multi');

let root: string;
let edges: SynthesizedEdge[];
let byId: Map<string, Node>;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'harmony-nav-'));
  cpSync(FIXTURE, root, { recursive: true });
  const cg = await CodeGraph.init(root, { index: true });
  cg.close();

  const reader = CodeSymbolGraph.open(root);
  try {
    edges = reader.getSynthesizedEdges(['harmony-nav']);
    byId = new Map(reader.getAllNodes().map((n) => [n.id, n]));
  } finally {
    reader.close();
  }
}, 120_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/** `sourceName → targetName` for readable assertions. */
function pairs(): string[] {
  return edges.map((e) => `${byId.get(e.source)?.name} → ${byId.get(e.target)?.name}`).sort();
}

describe('route resolution', () => {
  it('resolves an enum-member route name through the registry', () => {
    // `RouterModule.push({ url: RouterMap.ORDER_LIST })` → 'OrderList' → page.
    // 63% of real call sites take this shape, so without enum back-resolution
    // most navigation would be invisible.
    expect(pairs()).toContain('build → OrderListPage');
    const e = edges.find((x) => x.metadata.route === 'OrderList')!;
    expect(e.metadata.resolvedBy).toBe('enum');
  });

  it('resolves a route whose name, file and struct ALL differ', () => {
    // route `OrderDetail` → `OrderDetailPage.ets` → `buildOrderDetailPage`.
    // Only the route table connects these; no naming convention would.
    const e = edges.find((x) => x.metadata.route === 'OrderDetail')!;
    expect(e).toBeDefined();
    expect(byId.get(e.target)!.name).toBe('OrderDetailPage');
  });

  it('crosses module boundaries — enum in commons, call in features', () => {
    // `RouterMap` lives in commons/lib_foundation; the call is in features/order.
    const e = edges.find((x) => x.metadata.route === 'OrderDetail')!;
    expect(byId.get(e.source)!.filePath).toContain('features/order');
    expect(byId.get(e.target)!.filePath).toContain('features/order');
  });

  it('links the ability to its first screen via windowStage.loadContent', () => {
    const e = edges.find((x) => x.metadata.via === 'loadContent')!;
    expect(e).toBeDefined();
    expect(byId.get(e.source)!.name).toBe('onWindowStageCreate');
    expect(byId.get(e.target)!.name).toBe('Index');
  });

  it('tags every edge with its family, route and wiring site', () => {
    expect(edges.length).toBeGreaterThan(0);
    for (const e of edges) {
      expect(e.metadata.synthesizedBy).toBe('harmony-nav');
      expect(typeof e.metadata.route).toBe('string');
      expect(typeof e.metadata.registeredAt).toBe('string');
    }
  });
});

describe('precise-or-drop', () => {
  it('produces NO edge for a runtime-computed route name', () => {
    // `RouterModule.push({ url: info.url })` in components/feedback/Dyn.ets —
    // the shape of the majority of non-literal call sites. Guessing here would
    // wire every dynamic navigation to an arbitrary page.
    const fromDyn = edges.filter((e) => byId.get(e.source)?.filePath.includes('Dyn.ets'));
    expect(fromDyn).toEqual([]);
  });

  it('produces NO edge for a name that is not a registered route', () => {
    const registered = new Set(['HomePage', 'OrderDetail', 'OrderList', 'views/Index']);
    for (const e of edges) expect(registered.has(String(e.metadata.route))).toBe(true);
  });

  it('does not bind array builtins to the RouterModule singleton', () => {
    // `this.items.push(name)` in OrderVM must not resolve to `RouterModule.push`
    // — the false-coupling bug that produced 63 bogus cross-module edges on the
    // Calculator template.
    const addItem = [...byId.values()].find((n) => n.name === 'addItem');
    expect(addItem).toBeDefined();
    const fromAddItem = edges.filter((e) => e.source === addItem!.id);
    expect(fromAddItem).toEqual([]);
  });
});
