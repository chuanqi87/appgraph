/**
 * T2 · layout control trees + resource inventory reach the work order.
 *
 * Three seams:
 *   A · `detectResources` enriches each `xml-layout` Screen with a bounded,
 *       source-ordered control tree (id / key attrs / nesting / include),
 *       capped at 200 nodes and 12 deep.
 *   B · `assembleModuleBrief` aggregates a module's `res/values/*` Resource
 *       nodes into `ModuleBrief.resources` (per-type counts + string keys).
 *   C · a screen's control tree(s) reach `ScreenBrief.controls` (hosted layout
 *       for an Activity/Fragment, own tree for a standalone layout) and render
 *       as an indented outline, and the resource inventory renders as a section.
 * Plus the determinism contract (two runs → byte-identical).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectResources, ControlNode } from '../../src/appgraph/detect/resources';
import { ModuleRef } from '../../src/appgraph/detect/manifest-capabilities';
import { emptyMigrationGraph, mergeInto, MigrationGraph, MigrationUnit } from '../../src/migration/types';
import { AppEdge, AppNode, makeEdgeId, makeNodeId, screenMatchKey } from '../../src/appgraph/schema';
import { Node } from '../../src/types';
import { ControlTree, ModuleBrief, assembleModuleBrief } from '../../src/migration/plan/context';
import { renderUnitBrief } from '../../src/migration/plan/brief';
import { buildAssemblyInput } from '../../src/migration/plan';
import { CodeSymbolGraph } from '../../src/appgraph/graph-reader';

// --- helpers ----------------------------------------------------------------

function mkTemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mig-t2-'));
}
function write(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

function id(kind: AppNode['kind'], matchKey: string): string {
  return makeNodeId('android', kind, matchKey);
}
function appNode(
  kind: AppNode['kind'],
  matchKey: string,
  name: string,
  attrs?: Record<string, unknown>,
  platformRef?: { file: string; symbol?: string },
  subtype?: string
): AppNode {
  return {
    id: id(kind, matchKey),
    kind,
    matchKey,
    name,
    platform: 'android',
    subtype,
    platformRef,
    provenance: 'source-static',
    fidelity: 'source-project',
    confidence: 1,
    attrs,
  };
}
function edge(
  kind: AppEdge['kind'],
  from: string,
  to: string,
  attrs?: Record<string, unknown>
): AppEdge {
  return { id: makeEdgeId(kind, from, to), kind, from, to, provenance: 'manifest', confidence: 1, attrs };
}
function stubReader(nodes: Node[] = []): CodeSymbolGraph {
  return { getAllNodes: () => nodes, getCode: () => null } as unknown as CodeSymbolGraph;
}

function brief(over: Partial<ModuleBrief> = {}): ModuleBrief {
  return {
    moduleId: 'm',
    moduleName: ':app',
    files: [],
    publicInterface: [],
    capabilities: [],
    dependencies: [],
    testDependencies: [],
    impliedDependencies: [],
    screens: [],
    dataModels: [],
    permissionCapabilities: [],
    backgroundComponents: [],
    appEntries: [],
    deeplinks: [],
    ...over,
  };
}
function unit(over: Partial<MigrationUnit> = {}): MigrationUnit {
  return { id: 'u1', moduleIds: ['m'], label: ':app', order: 0, cyclic: false, ...over };
}

/** Max node depth in a control tree (root = 0). */
function maxDepth(node: ControlNode, depth = 0): number {
  if (!node.children || node.children.length === 0) return depth;
  return Math.max(...node.children.map((c) => maxDepth(c, depth + 1)));
}

// --- A · control-tree extraction --------------------------------------------

describe('T2 · A · control-tree extraction', () => {
  it('captures id, key attrs, nesting and <include>, in source order', () => {
    const root = mkTemp();
    try {
      write(
        root,
        'app/src/main/res/layout/activity_main.xml',
        '<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"\n' +
          '  android:orientation="vertical" android:layout_width="match_parent" android:layout_height="match_parent">\n' +
          '  <TextView android:id="@+id/title" android:text="@string/app_name"\n' +
          '    android:layout_width="wrap_content" android:layout_height="wrap_content"/>\n' +
          '  <include layout="@layout/toolbar"/>\n' +
          '  <LinearLayout android:id="@+id/row">\n' +
          '    <Button android:id="@+id/go" android:text="@string/ok"/>\n' +
          '  </LinearLayout>\n' +
          '</LinearLayout>\n'
      );
      const res = detectResources(root, [{ id: 'm-app', name: ':app', dir: 'app' }]);
      const layout = res.layoutScreenNodes[0]!;

      // Distinct-tag set (unchanged) + true element total (new).
      expect(layout.attrs!.totalControls).toBe(5);
      expect(layout.attrs!.controlTreeTruncated).toBeUndefined();

      const tree = layout.attrs!.controlTree as ControlNode;
      expect(tree.tag).toBe('LinearLayout');
      expect(tree.attrs).toEqual({ orientation: 'vertical', w: 'match', h: 'match' });
      // Source order preserved: TextView, include, LinearLayout.
      expect(tree.children!.map((c) => c.tag)).toEqual(['TextView', 'include', 'LinearLayout']);

      const [title, inc, rowGroup] = tree.children!;
      expect(title!.id).toBe('title'); // @+id/ stripped
      expect(title!.attrs).toEqual({ text: '@string/app_name', w: 'wrap', h: 'wrap' });
      expect(inc!.include).toBe('toolbar'); // @layout/ stripped
      expect(rowGroup!.id).toBe('row');
      expect(rowGroup!.children![0]!.id).toBe('go');
      expect(rowGroup!.children![0]!.attrs!.text).toBe('@string/ok');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('caps the node count at 200 and marks the tree truncated', () => {
    const root = mkTemp();
    try {
      const rows = Array.from({ length: 300 }, (_, i) => `  <TextView android:id="@+id/t${i}"/>`).join('\n');
      write(
        root,
        'app/src/main/res/layout/big.xml',
        `<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android">\n${rows}\n</LinearLayout>\n`
      );
      const res = detectResources(root, [{ id: 'm-app', name: ':app', dir: 'app' }]);
      const layout = res.layoutScreenNodes[0]!;

      expect(layout.attrs!.totalControls).toBe(301); // true total, pre-truncation
      expect(layout.attrs!.controlTreeTruncated).toBe(true);
      const tree = layout.attrs!.controlTree as ControlNode;
      // 200-node budget: root + 199 kept children, then elided.
      expect(tree.children!.length).toBe(199);
      expect(tree.truncated).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('caps nesting depth at 12', () => {
    const root = mkTemp();
    try {
      let xml = '';
      for (let i = 0; i < 15; i++) xml += `<FrameLayout android:id="@+id/d${i}">`;
      xml += '<TextView/>';
      for (let i = 0; i < 15; i++) xml += '</FrameLayout>';
      write(
        root,
        'app/src/main/res/layout/deep.xml',
        xml.replace('<FrameLayout ', '<FrameLayout xmlns:android="http://schemas.android.com/apk/res/android" ')
      );
      const res = detectResources(root, [{ id: 'm-app', name: ':app', dir: 'app' }]);
      const layout = res.layoutScreenNodes[0]!;
      const tree = layout.attrs!.controlTree as ControlNode;

      expect(layout.attrs!.controlTreeTruncated).toBe(true);
      expect(maxDepth(tree)).toBe(12); // deeper subtree elided
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('emits string key names on the values Resource node', () => {
    const root = mkTemp();
    try {
      write(
        root,
        'app/src/main/res/values/strings.xml',
        '<resources>\n  <string name="ok">OK</string>\n  <string name="cancel">Cancel</string>\n  <color name="bg">#fff</color>\n</resources>\n'
      );
      const res = detectResources(root, [{ id: 'm-app', name: ':app', dir: 'app' }]);
      const values = res.resourceNodes[0]!;
      expect(values.attrs!.stringNames).toEqual(['cancel', 'ok']); // sorted, colors excluded
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// --- B · module resource inventory ------------------------------------------

describe('T2 · B · ModuleBrief.resources', () => {
  function resourceGraph(stringNames: string[]): MigrationGraph {
    const graph = emptyMigrationGraph({ platform: 'android', app: { name: 't', packageName: 'com.t' } });
    const mApp = appNode('ArchModule', 'module:app', ':app', { dir: 'app' });
    const strings = appNode(
      'Resource',
      'resource:strings',
      'strings.xml',
      { byType: { string: stringNames.length, plurals: 1 }, entryCount: stringNames.length + 1, stringNames },
      { file: 'app/src/main/res/values/strings.xml' },
      'string'
    );
    const colors = appNode(
      'Resource',
      'resource:colors',
      'colors.xml',
      { byType: { color: 4 }, entryCount: 4, stringNames: [] },
      { file: 'app/src/main/res/values/colors.xml' },
      'color'
    );
    mergeInto(graph, {
      nodes: [mApp, strings, colors],
      edges: [
        edge('app_contains', mApp.id, strings.id, { kind: 'resource' }),
        edge('app_contains', mApp.id, colors.id, { kind: 'resource' }),
      ],
    });
    return graph;
  }

  it('aggregates per-type counts, total and string keys across values files', () => {
    const input = buildAssemblyInput(resourceGraph(['app_name', 'ok', 'cancel']), stubReader());
    const b = assembleModuleBrief(id('ArchModule', 'module:app'), input);

    expect(b.resources).toBeDefined();
    expect(b.resources!.byType).toEqual({ string: 3, plurals: 1, color: 4 });
    expect(b.resources!.total).toBe(4 + 4); // strings entryCount(4) + colors(4)
    expect(b.resources!.fileCount).toBe(2);
    expect(b.resources!.stringKeys).toEqual(['app_name', 'cancel', 'ok']); // sorted
    expect(b.resources!.stringKeyOverflow).toBe(0);
  });

  it('caps the string-key sample at 30 with an overflow count', () => {
    const keys = Array.from({ length: 42 }, (_, i) => `k${String(i).padStart(2, '0')}`);
    const input = buildAssemblyInput(resourceGraph(keys), stubReader());
    const b = assembleModuleBrief(id('ArchModule', 'module:app'), input);
    expect(b.resources!.stringKeys.length).toBe(30);
    expect(b.resources!.stringKeyOverflow).toBe(12);
  });

  it('leaves resources undefined for a module with no values resources', () => {
    const graph = emptyMigrationGraph({ platform: 'android', app: { name: 't', packageName: '' } });
    mergeInto(graph, { nodes: [appNode('ArchModule', 'module:app', ':app', { dir: 'app' })], edges: [] });
    const input = buildAssemblyInput(graph, stubReader());
    const b = assembleModuleBrief(id('ArchModule', 'module:app'), input);
    expect(b.resources).toBeUndefined();
  });
});

// --- C · control trees reach ScreenBrief.controls + render ------------------

describe('T2 · C · ScreenBrief.controls (assembly + render)', () => {
  const smallTree: ControlNode = {
    tag: 'LinearLayout',
    attrs: { orientation: 'vertical' },
    children: [{ tag: 'TextView', id: 'title', attrs: { text: '@string/app_name' } }],
  };

  it('attaches a hosted layout tree to the hosting Activity screen', () => {
    const graph = emptyMigrationGraph({ platform: 'android', app: { name: 't', packageName: '' } });
    const mApp = appNode('ArchModule', 'module:app', ':app', { dir: 'app' });
    const main = appNode(
      'Screen',
      screenMatchKey('MainActivity'),
      'MainActivity',
      undefined,
      { file: 'app/src/main/java/com/t/MainActivity.kt' },
      'activity'
    );
    const layout = appNode(
      'Screen',
      screenMatchKey('layout_activity_main'),
      'activity_main',
      { framework: 'android-view', controlTree: smallTree, totalControls: 2 },
      { file: 'app/src/main/res/layout/activity_main.xml' },
      'xml-layout'
    );
    mergeInto(graph, {
      nodes: [mApp, main, layout],
      edges: [
        edge('app_contains', mApp.id, main.id),
        edge('app_contains', mApp.id, layout.id, { kind: 'screen' }),
        edge('app_contains', main.id, layout.id, { via: 'set-content-view' }),
      ],
    });
    const input = buildAssemblyInput(graph, stubReader());
    const b = assembleModuleBrief(mApp.id, input);

    // The hosted layout is NOT a standalone screen; MainActivity carries its tree.
    expect(b.screens.map((s) => s.name)).toEqual(['MainActivity']);
    const controls = b.screens[0]!.controls!;
    expect(controls).toHaveLength(1);
    expect(controls[0]!.layout).toBe('activity_main');
    expect(controls[0]!.controlCount).toBe(2);
    expect(controls[0]!.root.tag).toBe('LinearLayout');
  });

  it('attaches a standalone xml-layout screen its own tree', () => {
    const graph = emptyMigrationGraph({ platform: 'android', app: { name: 't', packageName: '' } });
    const mApp = appNode('ArchModule', 'module:app', ':app', { dir: 'app' });
    const layout = appNode(
      'Screen',
      screenMatchKey('layout_row_item'),
      'row_item',
      { framework: 'android-view', controlTree: smallTree, totalControls: 2 },
      { file: 'app/src/main/res/layout/row_item.xml' },
      'xml-layout'
    );
    mergeInto(graph, {
      nodes: [mApp, layout],
      edges: [edge('app_contains', mApp.id, layout.id, { kind: 'screen' })],
    });
    const input = buildAssemblyInput(graph, stubReader());
    const b = assembleModuleBrief(mApp.id, input);
    expect(b.screens[0]!.name).toBe('row_item');
    expect(b.screens[0]!.controls![0]!.root.children![0]!.id).toBe('title');
  });

  it('renders the control tree as an indented outline with the rewrite note', () => {
    const controls: ControlTree[] = [{ layout: 'activity_main', controlCount: 2, root: smallTree }];
    const md = renderUnitBrief(
      unit(),
      [brief({ screens: [{ name: 'MainActivity', subtype: 'activity', navigatesTo: [], layouts: ['activity_main'], controls }] })],
      3
    );
    expect(md).toContain('控件树 [静态]');
    expect(md).toContain('ArkUI 无 View 继承');
    expect(md).toContain('@layout/activity_main(2 控件)');
    expect(md).toContain('- LinearLayout (orientation=vertical)');
    expect(md).toContain('- TextView #title (text=@string/app_name)');
  });

  it('elides a large control tree with a total count', () => {
    const children: ControlNode[] = Array.from({ length: 99 }, (_, i) => ({ tag: 'TextView', id: `t${i}` }));
    const root: ControlNode = { tag: 'LinearLayout', children };
    const controls: ControlTree[] = [{ layout: 'big', controlCount: 100, root }];
    const md = renderUnitBrief(
      unit(),
      [brief({ screens: [{ name: 'BigActivity', subtype: 'activity', navigatesTo: [], layouts: [], controls }] })],
      3
    );
    expect(md).toContain('…等共 100 个控件');
    // Rendered budget is 60 lines; the 90th control must not appear.
    expect(md).not.toContain('- TextView #t90');
  });

  it('renders the resource inventory section', () => {
    const md = renderUnitBrief(
      unit(),
      [brief({ resources: { byType: { string: 12, color: 3 }, total: 15, fileCount: 2, stringKeys: ['app_name', 'ok'], stringKeyOverflow: 40 } })],
      3
    );
    expect(md).toContain('### 资源 [静态]');
    expect(md).toContain('element/string.json');
    expect(md).toContain('string×12 · color×3');
    expect(md).toContain('string 键样例:app_name, ok …另有 40+ 个键(样本已截断)');
  });

  it('suppresses the resource section on a split sibling slice (points at first slice)', () => {
    const b = brief({ files: ['app/src/S.kt'], resources: { byType: { string: 5 }, total: 5, fileCount: 1, stringKeys: ['ok'], stringKeyOverflow: 0 } });
    const first = renderUnitBrief(unit({ kind: 'split', featureSig: 'sigA', files: ['app/src/S.kt'] }), [b], 5, undefined, undefined, undefined);
    const sibling = renderUnitBrief(unit({ kind: 'split', featureSig: 'sigB', files: ['app/src/S.kt'], order: 3 }), [b], 5, undefined, undefined, '2');
    expect(first).toContain('### 资源 [静态]');
    expect(sibling).not.toContain('### 资源 [静态]');
    expect(sibling).toContain('资源'); // named in the「见本模块首片」pointer
  });
});

// --- determinism ------------------------------------------------------------

describe('T2 · determinism', () => {
  it('extraction + assembly + render are byte-stable across two runs', () => {
    const root = mkTemp();
    try {
      write(
        root,
        'app/src/main/res/layout/activity_main.xml',
        '<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android">\n  <TextView android:id="@+id/title" android:text="@string/x"/>\n</LinearLayout>\n'
      );
      write(root, 'app/src/main/res/values/strings.xml', '<resources><string name="x">y</string></resources>');
      const a = detectResources(root, [{ id: 'm', name: ':app', dir: 'app' }]);
      const b = detectResources(root, [{ id: 'm', name: ':app', dir: 'app' }]);
      expect(JSON.stringify(a.layoutScreenNodes)).toBe(JSON.stringify(b.layoutScreenNodes));
      expect(JSON.stringify(a.resourceNodes)).toBe(JSON.stringify(b.resourceNodes));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
