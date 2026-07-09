/**
 * P1-3 · unit-granularity signals: functional Feature sections + token estimate.
 *
 * A large module's brief now groups its files by the M2 Feature they belong to
 * (so the conversion agent migrates cluster-by-cluster, not off a flat file
 * list), and every unit carries a rough migration-size token estimate so an
 * orchestrator can decide whether to split it / which model context to use.
 */

import { describe, it, expect } from 'vitest';
import { emptyMigrationGraph, mergeInto } from '../../src/migration/types';
import { AppNode, makeNodeId } from '../../src/appgraph/schema';
import { Node } from '../../src/types';
import { buildAssemblyInput, estimateUnitTokens, SYMBOL_TOKEN_COEFF } from '../../src/migration/plan';
import { assembleModuleBrief } from '../../src/migration/plan/context';
import { CodeSymbolGraph } from '../../src/appgraph/graph-reader';

function codeNode(id: string, name: string, filePath: string): Node {
  return {
    id, kind: 'class', name, qualifiedName: name, filePath, language: 'kotlin',
    startLine: 1, endLine: 1, startColumn: 0, endColumn: 0, updatedAt: 0, visibility: 'public',
  } as Node;
}

function archModule(matchKey: string, name: string, dir: string): AppNode {
  return {
    id: makeNodeId('android', 'ArchModule', matchKey), kind: 'ArchModule', matchKey, name,
    platform: 'android', provenance: 'manifest', fidelity: 'source-project', confidence: 1,
    attrs: { dir, role: 'app', symbolCount: 4 },
  };
}

function feature(sig: string, name: string, moduleId: string, members: string[], role: string, extra: Record<string, unknown> = {}): AppNode {
  return {
    id: makeNodeId('android', 'Feature', `feature:${sig}`), kind: 'Feature', matchKey: `feature:${sig}`,
    name, platform: 'android', subtype: role, provenance: 'lifted', fidelity: 'source-project', confidence: 0.6,
    attrs: { sig, role, size: members.length, cohesion: 0.4, moduleSpan: [moduleId], members, ...extra },
  };
}

describe('P1-3 · Feature sections', () => {
  it('groups a module\'s files by the subdivision Features that cover them', () => {
    const g = emptyMigrationGraph({ platform: 'android', app: { name: 'x', packageName: 'x' } });
    const mod = archModule('module:app', ':app', 'app');
    // 4 files; two functional clusters + one uncovered file.
    const files = ['app/Feed.kt', 'app/FeedVm.kt', 'app/Settings.kt', 'app/Glue.kt'];
    mergeInto(g, {
      nodes: [
        mod,
        feature('feedsig', 'Feed', mod.id, ['app/Feed.kt', 'app/FeedVm.kt'], 'subdivision'),
        feature('setsig', 'Settings', mod.id, ['app/Settings.kt'], 'subdivision'),
        feature('alignsig', 'Whole', mod.id, files, 'aligned'), // aligned → skipped
      ],
    });
    const reader = {
      getAllNodes: () => files.map((f, i) => codeNode(`n${i}`, `C${i}`, f)),
      getCode: () => null,
    } as unknown as CodeSymbolGraph;

    const input = buildAssemblyInput(g, reader);
    const b = assembleModuleBrief(mod.id, input);
    // Largest cluster (Feed, 2 files) leads; aligned Feature is not a section.
    expect(b.featureSections.map((s) => s.name)).toEqual(['Feed', 'Settings']);
    expect(b.featureSections[0]!.files).toEqual(['app/Feed.kt', 'app/FeedVm.kt']);
    expect(b.featureSections[1]!.files).toEqual(['app/Settings.kt']);
  });

  it('narrows sections to a split slice\'s own files via the file filter', () => {
    const g = emptyMigrationGraph({ platform: 'android', app: { name: 'x', packageName: 'x' } });
    const mod = archModule('module:app', ':app', 'app');
    mergeInto(g, {
      nodes: [mod, feature('feedsig', 'Feed', mod.id, ['app/Feed.kt', 'app/FeedVm.kt'], 'subdivision')],
    });
    const reader = {
      getAllNodes: () => [codeNode('n0', 'Feed', 'app/Feed.kt'), codeNode('n1', 'FeedVm', 'app/FeedVm.kt')],
      getCode: () => null,
    } as unknown as CodeSymbolGraph;
    const input = buildAssemblyInput(g, reader);
    // A split unit sees only app/Feed.kt — the section narrows to it.
    const b = assembleModuleBrief(mod.id, input, new Set(['app/Feed.kt']));
    expect(b.featureSections).toHaveLength(1);
    expect(b.featureSections[0]!.files).toEqual(['app/Feed.kt']);
  });
});

describe('P1-3 · token estimate', () => {
  it('scales the symbol count by the coefficient', () => {
    expect(estimateUnitTokens(0)).toBe(0);
    expect(estimateUnitTokens(100)).toBe(100 * SYMBOL_TOKEN_COEFF);
  });
});
