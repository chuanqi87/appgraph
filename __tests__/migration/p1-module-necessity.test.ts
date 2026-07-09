/**
 * P1-2 · module necessity classification + dev-only sink.
 *
 * Real-project audit: `:benchmarks` (a macrobenchmark module) was ordered
 * position 0, presented to the conversion agent as the very first thing to
 * migrate, even though it ships nothing. Dev-support modules (benchmark /
 * test-support / lint) are now tagged `attrs.necessity = 'dev-only'` and sink
 * below equally-ready product units without breaking any topological
 * constraint. The brief flags them and migrate_order surfaces the count.
 */

import { describe, it, expect } from 'vitest';
import { parseGradleModule, buildModuleGraph } from '../../src/appgraph/extractors/android/gradle';
import { computeMigrationOrder } from '../../src/migration/order/topo';
import { AppNode, AppEdge } from '../../src/appgraph/schema';

function necessityOf(nodes: AppNode[], name: string): unknown {
  return nodes.find((n) => n.name === name)?.attrs?.necessity;
}

describe('P1-2 · classifyModule necessity', () => {
  it('tags benchmark / test-support / lint modules dev-only, product otherwise', () => {
    const mods = [
      parseGradleModule('benchmarks', ''),
      parseGradleModule('macrobenchmark', ''),
      parseGradleModule('core/testing', ''),
      parseGradleModule('sync/sync-test', ''),
      parseGradleModule('lint', ''),
      parseGradleModule('feature/foryou/impl', ''),
      parseGradleModule('core/data', ''),
    ];
    const { nodes } = buildModuleGraph(mods);
    expect(necessityOf(nodes as AppNode[], ':benchmarks')).toBe('dev-only');
    expect(necessityOf(nodes as AppNode[], ':macrobenchmark')).toBe('dev-only');
    expect(necessityOf(nodes as AppNode[], ':core:testing')).toBe('dev-only');
    expect(necessityOf(nodes as AppNode[], ':sync:sync-test')).toBe('dev-only');
    expect(necessityOf(nodes as AppNode[], ':lint')).toBe('dev-only');
    // subtype (role) reflects the dev-support role, not 'app'/'feature'.
    const bench = (nodes as AppNode[]).find((n) => n.name === ':benchmarks');
    expect(bench?.subtype).toBe('benchmark');
    // Product code stays product.
    expect(necessityOf(nodes as AppNode[], ':feature:foryou:impl')).toBe('product');
    expect(necessityOf(nodes as AppNode[], ':core:data')).toBe('product');
  });

  it('does not mistake a product module with test-scoped deps for dev-only', () => {
    // `:app` merely uses testImplementation — it is still product code.
    const app = parseGradleModule('app', 'testImplementation(project(":core:testing"))');
    const { nodes } = buildModuleGraph([app, parseGradleModule('core/testing', '')]);
    expect(necessityOf(nodes as AppNode[], ':app')).toBe('product');
  });
});

describe('P1-2 · dev-only sinks in the topo order', () => {
  it('a dev-only leaf never wins order 0 over a ready product unit', () => {
    // `:benchmarks` depends on nothing internal (a bare leaf) — without the
    // sink it would sort by label ahead of the product leaves. `:core:data` is
    // an equally-ready product leaf. Product must come first.
    const bench = parseGradleModule('benchmarks', '');
    const data = parseGradleModule('core/data', '');
    const model = parseGradleModule('core/model', '');
    const { nodes, edges } = buildModuleGraph([bench, data, model]);

    const { order } = computeMigrationOrder(nodes as AppNode[], edges as AppEdge[]);
    const first = order.units[0]!;
    expect(first.necessity).toBeUndefined(); // order 0 is a product unit
    const benchUnit = order.units.find((u) => u.label === ':benchmarks')!;
    expect(benchUnit.necessity).toBe('dev-only');
    // Every product unit sits before the dev-only unit within the same wave.
    const productWave = order.units.filter((u) => u.necessity !== 'dev-only').map((u) => u.order);
    expect(Math.max(...productWave)).toBeLessThan(benchUnit.order);
  });

  it('an SCC mixing a product module keeps the whole unit on the product track', () => {
    // benchmarks ⇄ app cycle: even though benchmarks is dev-support, the unit
    // contains a product module, so it is NOT flagged dev-only.
    const app = parseGradleModule('app', 'implementation(project(":benchmarks"))');
    const bench = parseGradleModule('benchmarks', 'implementation(project(":app"))');
    const { nodes, edges } = buildModuleGraph([app, bench]);
    const { order, stats } = computeMigrationOrder(nodes as AppNode[], edges as AppEdge[]);
    expect(stats.cyclicUnits).toBe(1);
    expect(order.units[0]!.necessity).toBeUndefined();
  });
});
