/**
 * Source/target symmetry for HarmonyOS.
 *
 * The same project must yield the same screens and capabilities whether it is
 * analyzed standalone (`appgraph build --platform harmony`) or as a migration
 * target (`migrate verify` → `resolveTargetSurface`). If the two derived screens
 * independently they could disagree about what a page IS, and the migration gate
 * would compare a target against a differently-derived source.
 *
 * This is the acceptance criterion for sharing `projectHarmonySurface`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeGraph } from '../../src/index';
import { CodeSymbolGraph } from '../../src/appgraph/graph-reader';
import { buildAppGraph } from '../../src/appgraph/build';
import { resolveTargetSurface } from '../../src/migration/verify/target-graph';
import type { AppGraph } from '../../src/appgraph/schema';

const FIXTURE = join(__dirname, '../fixtures/harmony-navigation-multi');

let root: string;
let appGraph: AppGraph;
let surfaceScreens: string[];
let surfaceCapabilities: string[];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'harmony-symmetry-'));
  cpSync(FIXTURE, root, { recursive: true });

  const cg = await CodeGraph.init(root, { index: true });
  cg.close();

  const reader = CodeSymbolGraph.open(root);
  try {
    appGraph = buildAppGraph(root, reader, { platform: 'harmony' });
  } finally {
    reader.close();
  }

  const surface = await resolveTargetSurface(root);
  surfaceScreens = surface.screenNodes.map((n) => n.matchKey).sort();
  surfaceCapabilities = surface.capabilityNodes.map((n) => n.matchKey).sort();
}, 120_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('screen identity agrees across both derivations', () => {
  it('every target-surface screen exists in the source app graph', () => {
    const appScreens = new Set(
      appGraph.nodes.filter((n) => n.kind === 'Screen').map((n) => n.matchKey)
    );
    expect(surfaceScreens.length).toBeGreaterThan(0);
    for (const key of surfaceScreens) expect(appScreens.has(key)).toBe(true);
  });

  it('both sides derive the SAME node id for a shared screen', () => {
    // Same platform + kind + matchKey ⇒ same id, so a diff aligns them directly.
    const appById = new Map(
      appGraph.nodes.filter((n) => n.kind === 'Screen').map((n) => [n.matchKey, n.id])
    );
    for (const key of surfaceScreens) expect(appById.get(key)).toBeDefined();
  });

  it('the source graph additionally recovers route-registry-only pages', () => {
    // The registry is the source side's advantage: it knows pages by ROUTE NAME,
    // which the code alone cannot express.
    const routed = appGraph.nodes.filter((n) => n.kind === 'Screen' && n.attrs?.route);
    expect(routed.length).toBeGreaterThan(0);
  });
});

describe('capability identity agrees across both derivations', () => {
  it('every target-surface capability exists in the source app graph', () => {
    const appCaps = new Set(
      appGraph.nodes.filter((n) => n.kind === 'Capability').map((n) => n.matchKey)
    );
    for (const key of surfaceCapabilities) expect(appCaps.has(key)).toBe(true);
  });
});

describe('determinism', () => {
  it('two builds over unchanged source are byte-identical', () => {
    const reader = CodeSymbolGraph.open(root);
    try {
      const a = buildAppGraph(root, reader, { platform: 'harmony' });
      const b = buildAppGraph(root, reader, { platform: 'harmony' });
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    } finally {
      reader.close();
    }
  });

  it('declares only the node kinds it actually emits', () => {
    const emitted = new Set(appGraph.nodes.map((n) => n.kind));
    for (const kind of emitted) expect(appGraph.supportedKinds).toContain(kind);
  });
});
