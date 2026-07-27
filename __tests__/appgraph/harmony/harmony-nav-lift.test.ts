/**
 * A2 · navigation lift — attribution and coverage reporting.
 *
 * The regression this file exists for: attribution used to start from the jump
 * site's FILE rather than the jumping FUNCTION. A shared utils file holding both
 * a navigating and a non-navigating entry point then attributed the jump to
 * every caller of either one, turning a single real edge into a star of
 * fabricated ones — 31–36% of all `navigates_to` edges on the two largest
 * corpus projects, each emitted at confidence 0.85.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeGraph } from '../../../src/index';
import { CodeSymbolGraph } from '../../../src/appgraph/graph-reader';
import { buildAppGraph } from '../../../src/appgraph/build';
import type { AppGraph } from '../../../src/appgraph/schema';

const FIXTURE = join(__dirname, '../../fixtures/harmony-navigation-multi');

let root: string;
let graph: AppGraph;

/** `From → To` by screen name, for readable assertions. */
function navPairs(): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return graph.edges
    .filter((e) => e.kind === 'navigates_to')
    .map((e) => `${byId.get(e.from)?.name} → ${byId.get(e.to)?.name}`)
    .sort();
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'harmony-nav-lift-'));
  cpSync(FIXTURE, root, { recursive: true });
  const cg = await CodeGraph.init(root, { index: true });
  cg.close();

  const reader = CodeSymbolGraph.open(root);
  try {
    graph = buildAppGraph(root, reader, { platform: 'harmony' });
  } finally {
    reader.close();
  }
}, 120_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('attribution walks from the jumping function', () => {
  it('attributes a VM-mediated jump to the page that calls the VM', () => {
    // OrderListPage → OrderVM.openDetail() → pushPathByName(RouterMap.ORDER_DETAIL)
    expect(navPairs()).toContain('OrderListPage → OrderDetailPage');
  });

  it('does NOT attribute a jump to callers of a NON-navigating sibling', () => {
    // `LoginUtils` holds both `openSheet()` (no navigation) and
    // `jumpLoginPage()` (navigates). SheetOnlyPage only calls `openSheet`, so it
    // must not inherit the jump — the fabricated-star regression.
    expect(navPairs()).not.toContain('SheetOnlyPage → OrderListPage');
    const fromSheetOnly = navPairs().filter((p) => p.startsWith('SheetOnlyPage →'));
    expect(fromSheetOnly).toEqual([]);
  });

  it('links the app entry to its first screen', () => {
    expect(navPairs()).toContain('EntryAbility → Index');
  });
});

describe('page inventory is complete', () => {
  it('recovers a page whose build() declares `: void`', () => {
    // `build(): void {` — 195 corpus uses; this used to read as "not a page".
    const screens = graph.nodes.filter((n) => n.kind === 'Screen').map((n) => n.name);
    expect(screens).toContain('SheetOnlyPage');
  });

  it('counts a route whose page file declares no struct of its own', () => {
    // `ReusedAddressPage.ets` is a three-line @Builder over a component imported
    // from another module. The page exists and is navigable, so dropping it made
    // the screen inventory silently short.
    const declared = graph.nodes.find(
      (n) => n.kind === 'Screen' && n.subtype === 'declared-route'
    );
    expect(declared?.name).toBe('ReusedAddressPage');
    expect(declared?.attrs?.routes).toEqual(['ReusedAddress']);
    // Counted, but honestly marked as not bound to a symbol.
    expect(declared?.attrs?.implementation).toBe('unresolved');
    expect(declared?.confidence).toBeLessThan(1);
  });

  it('still reports the unlocated implementation as a coverage warning', () => {
    expect(
      graph.coverageWarnings.some((w) => w.message.includes('未声明组件 struct'))
    ).toBe(true);
  });

  it('EVERY registered route is covered by some Screen', () => {
    const covered = new Set(
      graph.nodes
        .filter((n) => n.kind === 'Screen')
        .flatMap((n) => (n.attrs?.routes as string[] | undefined) ?? [])
    );
    expect([...covered].sort()).toEqual(['HomePage', 'OrderDetail', 'OrderList', 'ReusedAddress']);
  });
});

describe('coverage reporting', () => {
  it('names each registered route that no static jump reaches', () => {
    // An unreached route is a real hole in the navigation graph, never silence.
    const messages = graph.coverageWarnings.map((w) => w.message);
    expect(messages.some((m) => m.includes('已注册但无任何静态跳转来源'))).toBe(true);
  });

  it('every navigates_to edge carries its route and provenance', () => {
    for (const e of graph.edges.filter((x) => x.kind === 'navigates_to')) {
      expect(e.provenance).toBe('lifted');
      expect(e.attrs?.liftedFrom).toBe('harmony-nav');
    }
  });
});
