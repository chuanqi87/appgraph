/**
 * P1-C · plan-layer data-quality fixes (regression pins).
 *
 * Real-project audits (CatchUp / koler / NewPipe / nowinandroid) surfaced ways
 * the assembled work order lied to the conversion agent; each gets a pin here:
 *   - build-script symbols leaked into the public-interface baseline (T1-8);
 *   - anonymous-inner-class overrides, local functions and @Preview composables
 *     were counted as public surface (T1-3);
 *   - a zero-weight, evidence-less implicit coupling rendered as「权重 0()」(T1-9b);
 *   - a module split into N slices repeated its whole module-level fact tables on
 *     every slice, collapsing the signal-to-noise (T1-2).
 */

import { describe, it, expect } from 'vitest';
import { Node } from '../../src/types';
import { emptyMigrationGraph, mergeInto } from '../../src/migration/types';
import { AppNode, makeNodeId } from '../../src/appgraph/schema';
import { CodeSymbolGraph } from '../../src/appgraph/graph-reader';
import { ModuleBrief, assembleModuleBrief, extractPublicInterface } from '../../src/migration/plan/context';
import { renderUnitBrief, BriefUnit } from '../../src/migration/plan/brief';
import { buildAssemblyInput } from '../../src/migration/plan';

function node(
  id: string,
  kind: Node['kind'],
  name: string,
  qualifiedName: string,
  filePath: string,
  visibility: string = 'public'
): Node {
  return {
    id, kind, name, qualifiedName, filePath, language: 'kotlin',
    startLine: 1, endLine: 1, startColumn: 0, endColumn: 0, updatedAt: 0, visibility,
  } as Node;
}

function archModule(matchKey: string, name: string, dir: string): AppNode {
  return {
    id: makeNodeId('android', 'ArchModule', matchKey), kind: 'ArchModule', matchKey, name,
    platform: 'android', provenance: 'manifest', fidelity: 'source-project', confidence: 1,
    attrs: { dir },
  };
}

function brief(over: Partial<ModuleBrief> = {}): ModuleBrief {
  return {
    moduleId: 'm', moduleName: ':phone', files: [], publicInterface: [], capabilities: [],
    dependencies: [], testDependencies: [], impliedDependencies: [], screens: [], dataModels: [],
    permissionCapabilities: [], backgroundComponents: [], appEntries: [], deeplinks: [], ...over,
  } as ModuleBrief;
}

function splitUnit(over: Partial<BriefUnit> = {}): BriefUnit {
  return { order: 1, label: ':phone#f', cyclic: false, moduleIds: ['m'], kind: 'split', files: ['a.kt'], ...over };
}

// ---------------------------------------------------------------------------
// T1-8 · build-script symbols are not public surface.
// ---------------------------------------------------------------------------

describe('T1-8 · extractPublicInterface excludes build files', () => {
  it('drops members declared in build.gradle.kts / buildSrc', () => {
    const members = extractPublicInterface([
      node('a', 'class', 'Real', 'com.x::Real', 'app/src/main/kotlin/Real.kt'),
      node('b', 'class', 'CutChangelogTask', 'com.x::CutChangelogTask', 'app/build.gradle.kts'),
      node('c', 'class', 'BuildHelper', 'com.x::BuildHelper', 'buildSrc/src/main/kotlin/BuildHelper.kt'),
    ]);
    expect(members.map((m) => m.name)).toEqual(['Real']);
  });
});

// ---------------------------------------------------------------------------
// T1-3 · anonymous-inner-class overrides, local functions, previews.
// ---------------------------------------------------------------------------

describe('T1-3 · extractPublicInterface false positives', () => {
  it('drops members whose enclosing scope is a function/method, keeps genuine nested types', () => {
    const members = extractPublicInterface([
      // a method (never public surface) + a named override on the anon class inside it.
      node('m1', 'method', 'onSetup', 'com.x::MainActivity::onSetup', 'app/src/main/kotlin/MainActivity.kt'),
      node('f1', 'function', 'createFragment', 'com.x::MainActivity::onSetup::createFragment', 'app/src/main/kotlin/MainActivity.kt'),
      node('c1', 'class', 'MainActivity', 'com.x::MainActivity', 'app/src/main/kotlin/MainActivity.kt'),
      // a GENUINE nested type (enclosed by a class) — legit surface, kept.
      node('c2', 'class', 'Action', 'com.x::FeedEvent::Action', 'app/src/main/kotlin/FeedEvent.kt'),
      node('c3', 'class', 'FeedEvent', 'com.x::FeedEvent', 'app/src/main/kotlin/FeedEvent.kt'),
      // a local function inside a top-level function — dropped; the outer fn kept.
      node('f2', 'function', 'helper', 'com.x::doWork::helper', 'app/src/main/kotlin/Work.kt'),
      node('f3', 'function', 'doWork', 'com.x::doWork', 'app/src/main/kotlin/Work.kt'),
    ]);
    expect(members.map((m) => m.name)).toEqual(['FeedEvent', 'Action', 'MainActivity', 'doWork']);
  });

  it('drops a member enclosed by an anonymous scope', () => {
    const members = extractPublicInterface([
      node('c', 'class', 'Handler', 'com.x::Outer::<anon@12>::Handler', 'app/src/main/kotlin/Outer.kt'),
      node('o', 'class', 'Outer', 'com.x::Outer', 'app/src/main/kotlin/Outer.kt'),
    ]);
    expect(members.map((m) => m.name)).toEqual(['Outer']);
  });

  it('honours the exclude-id set (preview composables)', () => {
    const members = extractPublicInterface(
      [
        node('p', 'function', 'FooPreview', 'com.x::FooPreview', 'app/src/main/kotlin/Foo.kt'),
        node('r', 'function', 'realFn', 'com.x::realFn', 'app/src/main/kotlin/Foo.kt'),
      ],
      new Set(['p'])
    );
    expect(members.map((m) => m.name)).toEqual(['realFn']);
  });

  it('detects @Preview composables from source and excludes them end-to-end', () => {
    const graph = emptyMigrationGraph({ platform: 'android', app: { name: 'x', packageName: 'x' } });
    const mod = archModule('module:app', ':app', 'app');
    mergeInto(graph, { nodes: [mod] });
    const preview = node('fp', 'function', 'SettingsPreview', 'app/src/main/kotlin/S.kt::SettingsPreview', 'app/src/main/kotlin/S.kt');
    const real = node('cb', 'class', 'Settings', 'app/src/main/kotlin/S.kt::Settings', 'app/src/main/kotlin/S.kt');
    const code = new Map<string, string>([
      ['fp', '@Preview\n@Composable\nfun SettingsPreview() {}'],
      ['cb', 'class Settings'],
    ]);
    const reader = {
      getAllNodes: () => [preview, real],
      getCode: (n: Node) => code.get(n.id) ?? null,
    } as unknown as CodeSymbolGraph;

    const input = buildAssemblyInput(graph, reader);
    const b = assembleModuleBrief(mod.id, input);
    expect(b.publicInterface.map((m) => m.name)).toEqual(['Settings']);
  });
});

// ---------------------------------------------------------------------------
// T1-9b · a zero-weight, evidence-less implicit coupling is pure noise.
// ---------------------------------------------------------------------------

describe('T1-9b · empty implicit-coupling is skipped', () => {
  it('omits a weight-0, empty-byKind implied dependency (no「权重 0()」noise)', () => {
    const md = renderUnitBrief(
      { order: 0, label: ':phone', cyclic: false, moduleIds: ['m'] },
      [
        brief({
          impliedDependencies: [
            { moduleName: ':ghost', weight: 0, byKind: {} },
            { moduleName: ':core:common', weight: 12, byKind: { calls: 12 } },
          ],
        }),
      ],
      5
    );
    expect(md).not.toContain(':ghost');
    expect(md).not.toContain('权重 0()');
    expect(md).toContain('隐式耦合 [启发] **:core:common** — 权重 12(calls×12)');
  });
});

// ---------------------------------------------------------------------------
// T1-2 · a module's shared module-level facts render once (its first slice); the
// sibling slices point at it.
// ---------------------------------------------------------------------------

describe('T1-2 · split-sibling module-level fact dedup', () => {
  const shared = brief({
    moduleName: ':phone',
    di: { modules: ['CallModule'], provides: [], binds: [{ iface: 'X', impl: 'Y' }], injectionPoints: [], scopes: [] },
    backgroundComponents: [{ name: 'CallService', subtype: 'service' }],
    permissionCapabilities: ['call_phone'],
    constants: { literals: [{ name: 'BASE', value: 'https://x.example.com', kind: 'url', file: 'a.kt' }], routes: [], queries: [], enums: [] },
  });

  it('renders module-level facts IN FULL on the first slice (no pointer)', () => {
    const md = renderUnitBrief(splitUnit({ featureSig: 'sigA', files: ['a.kt'] }), [shared], 5, undefined, undefined, undefined);
    expect(md).toContain('### DI 装配');
    expect(md).toContain('### 后台组件');
    expect(md).toContain('权限能力 [清单]');
    expect(md).toContain('### 语义常量');
    expect(md).toContain('模块级事实(DI 装配/清单组件/能力)为全模块共享,列出仅供上下文。');
  });

  it('suppresses them on a sibling slice and points at the first slice', () => {
    const md = renderUnitBrief(splitUnit({ featureSig: 'sigB', files: ['b.kt'] }), [shared], 5, undefined, undefined, '1');
    expect(md).not.toContain('### DI 装配');
    expect(md).not.toContain('### 后台组件');
    expect(md).not.toContain('权限能力 [清单]');
    expect(md).not.toContain('### 语义常量');
    expect(md).toContain('见本模块首片(单元 1)');
  });

  it('a truncated @Query in the constants section is flagged for manual review (T1-5c)', () => {
    const md = renderUnitBrief(
      { order: 0, label: ':phone', cyclic: false, moduleIds: ['m'] },
      [
        brief({
          constants: {
            literals: [], routes: [], enums: [],
            queries: [{ sql: 'SELECT huge…', file: 'q.kt', truncated: true }],
          },
        }),
      ],
      5
    );
    expect(md).toContain('⚠SQL 截断,人工核对');
  });
});
