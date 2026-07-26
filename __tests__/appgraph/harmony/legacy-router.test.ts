/**
 * Legacy-router HarmonyOS project (`@ohos.router` + `main_pages.json`).
 *
 * The other harmony tests all exercise the mainstream Navigation system. This
 * one covers the older path, which differs in every respect: pages come from
 * `main_pages.json` and their `@Entry` decorator rather than a route table, and
 * jumps are `router.pushUrl({url:'pages/X'})` resolved by the pre-existing
 * `arkui-route` family rather than `harmony-nav`.
 *
 * The fixture is a deliberately PARTIAL migration of shadowsocks-android: it
 * omits the VPN capability and the `ss://` deep link so a cross-platform diff
 * has real gaps to surface. Those omissions are asserted here as absences, so
 * the fixture cannot silently drift into "complete".
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeGraph } from '../../../src/index';
import { CodeSymbolGraph } from '../../../src/appgraph/graph-reader';
import { buildAppGraph } from '../../../src/appgraph/build';
import { detectPlatform } from '../../../src/appgraph/platforms';
import type { AppGraph } from '../../../src/appgraph/schema';

const FIXTURE = join(__dirname, '../../fixtures/harmony-shadowsocks-partial');

let root: string;
let graph: AppGraph;

function names(kind: string): string[] {
  return graph.nodes.filter((n) => n.kind === kind).map((n) => n.name).sort();
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'harmony-legacy-'));
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

describe('project recognition', () => {
  it('detects HarmonyOS from AppScope even without a route table', () => {
    expect(detectPlatform(root)).toMatchObject({ platform: 'harmony', confidence: 1 });
  });

  it('recovers the single entry module', () => {
    expect(names('ArchModule')).toEqual(['entry']);
    expect(graph.app.packageName).toBe('com.github.shadowsocks');
  });
});

describe('legacy page + navigation recovery', () => {
  it('recovers @Entry pages without any route table', () => {
    expect(names('Screen')).toEqual(['MainPage', 'ProfilesPage']);
  });

  it('lifts a legacy router.pushUrl jump to navigates_to', () => {
    // Resolved by the `arkui-route` family (url path → file), not `harmony-nav`.
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const hops = graph.edges
      .filter((e) => e.kind === 'navigates_to')
      .map((e) => `${byId.get(e.from)?.name} → ${byId.get(e.to)?.name}`);
    expect(hops).toContain('MainPage → ProfilesPage');
  });

  it('recovers the launcher ability', () => {
    expect(names('AppEntry')).toEqual(['EntryAbility']);
  });
});

describe('the deliberate migration gaps stay gaps', () => {
  it('has no VPN capability — the source app has one, the port does not', () => {
    expect(names('Capability')).not.toContain('vpn');
  });

  it('exposes no deep link — the `ss://` scheme was not ported', () => {
    expect(graph.nodes.filter((n) => n.kind === 'Resource')).toEqual([]);
  });

  it('still recovers the permissions that WERE ported', () => {
    expect(names('Permission')).toEqual([
      'ohos.permission.GET_NETWORK_INFO',
      'ohos.permission.INTERNET',
      'ohos.permission.NOTIFICATION_CONTROLLER',
    ]);
  });
});
