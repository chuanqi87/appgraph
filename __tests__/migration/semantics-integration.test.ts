/**
 * U6 · resources/layouts, and a real-sample end-to-end integration.
 *
 * U6 is file-driven (walks `res/`), so it is tested with temp files. The
 * conditional block runs the whole `buildSemantics` orchestration against the
 * indexed nowinandroid sample when present, asserting the semantic inventory and
 * — critically — the DETERMINISM contract (two runs → byte-identical output).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectResources } from '../../src/appgraph/detect/resources';
import { ModuleRef } from '../../src/appgraph/detect/manifest-capabilities';
import { buildSemantics } from '../../src/appgraph/detect/semantics';
import { CodeSymbolGraph } from '../../src/appgraph/graph-reader';
import { buildModuleDependencyGraph } from '../../src/appgraph/modules';
import { assignNodesToModules } from '../../src/appgraph/modules/assign';
import { AppNode } from '../../src/appgraph/schema';

function mkTemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mig-u6-'));
}
function write(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

describe('U6 · resources + XML-View layouts', () => {
  it('emits a Resource node per values file and an xml-layout Screen per layout', () => {
    const root = mkTemp();
    try {
      write(
        root,
        'app/src/main/res/values/strings.xml',
        '<resources>\n  <string name="app_name">Nia</string>\n  <string name="ok">OK</string>\n</resources>\n'
      );
      write(
        root,
        'app/src/main/res/layout/activity_main.xml',
        '<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android">\n  <TextView android:id="@+id/title"/>\n  <Button android:id="@+id/go"/>\n</LinearLayout>\n'
      );
      // A test source set must be excluded.
      write(root, 'app/src/test/res/values/strings.xml', '<resources><string name="x">y</string></resources>');

      const modules: ModuleRef[] = [{ id: 'm-app', name: ':app', dir: 'app' }];
      const res = detectResources(root, modules);

      expect(res.stats.valueFiles).toBe(1);
      expect(res.stats.layoutFiles).toBe(1);
      const values = res.resourceNodes[0]!;
      expect(values.kind).toBe('Resource');
      expect(values.subtype).toBe('string');
      expect(values.attrs!.entryCount).toBe(2);
      const layout = res.layoutScreenNodes[0]!;
      expect(layout.kind).toBe('Screen');
      expect(layout.subtype).toBe('xml-layout');
      expect(layout.attrs!.controls).toEqual(expect.arrayContaining(['Button', 'LinearLayout', 'TextView']));
      // Both nodes attributed to :app via app_contains.
      expect(res.containsEdges.every((e) => e.from === 'm-app')).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('is deterministic across two runs', () => {
    const root = mkTemp();
    try {
      write(root, 'm/src/main/res/values/colors.xml', '<resources><color name="a">#fff</color></resources>');
      const modules: ModuleRef[] = [{ id: 'm', name: ':m', dir: 'm' }];
      const a = JSON.stringify(detectResources(root, modules).resourceNodes);
      const b = JSON.stringify(detectResources(root, modules).resourceNodes);
      expect(a).toBe(b);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// --- Real-sample integration (only when the indexed nowinandroid sample exists) ---
const SAMPLE = path.resolve(__dirname, '../../../references/samples/nowinandroid');
const HAS_SAMPLE = fs.existsSync(path.join(SAMPLE, '.codegraph', 'codegraph.db'));

/** module id → owning ArchModule id, via the same assignment the CLI uses. */
function nodeToModuleId(archModules: AppNode[], reader: CodeSymbolGraph): Map<string, string> {
  const dirToId = new Map<string, string>();
  const dirs: string[] = [];
  for (const m of archModules) {
    const dir = typeof m.attrs?.dir === 'string' ? m.attrs.dir : undefined;
    if (dir !== undefined) {
      dirToId.set(dir, m.id);
      dirs.push(dir);
    }
  }
  const assignment = assignNodesToModules(reader.getAllNodes(), dirs);
  const map = new Map<string, string>();
  for (const [nid, dir] of assignment.nodeToModuleDir) {
    const mid = dirToId.get(dir);
    if (mid) map.set(nid, mid);
  }
  return map;
}

describe.runIf(HAS_SAMPLE)('U · buildSemantics on real nowinandroid', () => {
  it('recovers screens/entities/roles and is byte-identical across two runs', () => {
    const reader = CodeSymbolGraph.open(SAMPLE);
    try {
      const mod = buildModuleDependencyGraph(SAMPLE, reader);
      const archModules = mod.nodes.filter((n) => n.kind === 'ArchModule');
      const map = nodeToModuleId(archModules, reader);

      const r1 = buildSemantics(reader, SAMPLE, archModules, map);
      const r2 = buildSemantics(reader, SAMPLE, archModules, map);

      // Determinism: nodes + edges byte-identical.
      expect(JSON.stringify(r1.nodes)).toBe(JSON.stringify(r2.nodes));
      expect(JSON.stringify(r1.edges)).toBe(JSON.stringify(r2.edges));

      // Semantic inventory (nowinandroid is Compose + Room).
      expect(r1.stats.screens).toBeGreaterThanOrEqual(5);
      const entities = r1.nodes.filter((n) => n.kind === 'DataModel' && n.subtype === 'entity');
      expect(entities.length).toBeGreaterThanOrEqual(5);
      const topic = entities.find((n) => n.name === 'TopicEntity');
      expect(topic, 'TopicEntity should be recovered').toBeTruthy();
      const fields = topic!.attrs!.fields as Array<{ name: string }>;
      expect(fields.map((f) => f.name)).toContain('id');
      // U1 role aggregation lands on ArchModule attrs.
      const withRoles = r1.nodes.filter((n) => n.kind === 'ArchModule' && n.attrs?.roleCounts);
      expect(withRoles.length).toBeGreaterThan(0);
      // S2 manifest structure: the launcher activity + its AppEntry reach the graph.
      const mainScreen = r1.nodes.find(
        (n) => n.kind === 'Screen' && n.subtype === 'activity' && n.name === 'MainActivity'
      );
      expect(mainScreen, 'MainActivity Screen should be recovered').toBeTruthy();
      expect(r1.nodes.some((n) => n.kind === 'AppEntry')).toBe(true);
    } finally {
      reader.close();
    }
  });
});
