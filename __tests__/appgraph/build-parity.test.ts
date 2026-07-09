/**
 * appgraph build ⇄ migrate pipeline parity.
 *
 * `buildAppGraph` (what `appgraph build` writes to .appgraph/app-graph.json) must
 * produce the SAME node/edge set as running the migration stage builders
 * (modules → community → capabilities → semantics) in sequence — the plan's
 * "同一 builder 函数" contract. Also pins determinism: two builds → byte-identical.
 *
 * Runs against a small synthetic Android module indexed into a real .codegraph db.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../src';
import { initGrammars, loadAllGrammars } from '../../src/extraction/grammars';
import { CodeSymbolGraph } from '../../src/appgraph/graph-reader';
import { buildAppGraph, moduleRefs, nodeToModuleId } from '../../src/appgraph/build';
import { canonicalJson } from '../../src/appgraph/serialize';
import { buildModuleDependencyGraph } from '../../src/appgraph/modules';
import { buildCommunityOverlay } from '../../src/appgraph/community';
import { detectCapabilities } from '../../src/appgraph/detect/api-capabilities';
import { detectManifestCapabilities } from '../../src/appgraph/detect/manifest-capabilities';
import { buildSemantics } from '../../src/appgraph/detect/semantics';
import { emptyMigrationGraph, mergeInto, MigrationGraph } from '../../src/migration/types';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function write(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

/** A minimal single-module Android app: gradle module + manifest + Kotlin source. */
function scaffold(root: string): void {
  write(root, 'app/build.gradle.kts', 'plugins { id("com.android.application") }\n');
  write(
    root,
    'app/src/main/AndroidManifest.xml',
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.parity.app">\n' +
      '  <uses-permission android:name="android.permission.CAMERA"/>\n' +
      '  <application>\n' +
      '    <activity android:name=".MainActivity" android:exported="true">\n' +
      '      <intent-filter>\n' +
      '        <action android:name="android.intent.action.MAIN"/>\n' +
      '        <category android:name="android.intent.category.LAUNCHER"/>\n' +
      '      </intent-filter>\n' +
      '    </activity>\n' +
      '  </application>\n' +
      '</manifest>\n'
  );
  write(
    root,
    'app/src/main/java/com/parity/app/MainActivity.kt',
    'package com.parity.app\n\n' +
      'import androidx.room.Room\n' +
      'import android.app.Activity\n\n' +
      'class MainActivity : Activity() {\n' +
      '  fun open() { Room.databaseBuilder(this, Any::class.java, "db") }\n' +
      '}\n'
  );
}

/** Build the graph the way the migrate stage commands do — the parity reference. */
function stagedPipeline(root: string, reader: CodeSymbolGraph): MigrationGraph {
  const graph = emptyMigrationGraph({
    platform: 'android',
    app: { name: path.basename(root), packageName: '' },
  });
  const mod = buildModuleDependencyGraph(root, reader);
  if (mod.packageName) graph.source.app.packageName = mod.packageName;
  mergeInto(graph, { nodes: mod.nodes, edges: mod.edges, warnings: mod.warnings });

  const archModules = graph.nodes.filter((n) => n.kind === 'ArchModule');
  const comm = buildCommunityOverlay(archModules, reader);
  mergeInto(graph, { nodes: comm.nodes, edges: comm.edges, warnings: comm.warnings });

  const api = detectCapabilities(reader.getAllNodes(), nodeToModuleId(archModules, reader));
  mergeInto(graph, { nodes: api.capabilityNodes, edges: api.edges });
  const manifest = detectManifestCapabilities(root, moduleRefs(archModules));
  mergeInto(graph, {
    nodes: [...manifest.permissionNodes, ...manifest.capabilityNodes],
    edges: manifest.usesEdges,
    warnings: manifest.warnings,
  });

  const semantics = buildSemantics(reader, root, archModules, nodeToModuleId(archModules, reader));
  mergeInto(graph, { nodes: semantics.nodes, edges: semantics.edges, warnings: semantics.warnings });
  graph.navFrameworks = semantics.navFrameworks; // mirror cmdSemantics (P0-3)
  return graph;
}

describe('appgraph build ⇄ migrate pipeline parity', () => {
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it('buildAppGraph node/edge set equals the staged migrate pipeline', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'appgraph-parity-'));
    scaffold(tmp);

    const cg = CodeGraph.initSync(tmp);
    await cg.indexAll();
    cg.close();

    const reader = CodeSymbolGraph.open(tmp);
    try {
      const app = buildAppGraph(tmp, reader, { platform: 'android' });
      const migration = stagedPipeline(tmp, reader);

      // Non-trivial: the module was discovered and enriched into a real graph.
      expect(app.nodes.some((n) => n.kind === 'ArchModule')).toBe(true);
      expect(app.nodes.length).toBeGreaterThan(1);

      // Node ids match one-for-one with the staged migrate pipeline.
      const appNodeIds = app.nodes.map((n) => n.id).sort();
      const migNodeIds = migration.nodes.map((n) => n.id).sort();
      expect(appNodeIds).toEqual(migNodeIds);

      // Edge ids match one-for-one.
      const appEdgeIds = app.edges.map((e) => e.id).sort();
      const migEdgeIds = migration.edges.map((e) => e.id).sort();
      expect(appEdgeIds).toEqual(migEdgeIds);

      // Fully identical nodes/edges (attrs included), not just id sets.
      expect(canonicalJson(app.nodes)).toEqual(canonicalJson(migration.nodes));
      expect(canonicalJson(app.edges)).toEqual(canonicalJson(migration.edges));
      expect(app.app.packageName).toEqual(migration.source.app.packageName);
      // Top-level nav-framework blind spots stay in parity too (P0-3).
      expect(app.navFrameworks).toEqual(migration.navFrameworks);
    } finally {
      reader.close();
    }
  });

  it('is deterministic — two builds produce byte-identical output', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'appgraph-determinism-'));
    scaffold(tmp);

    const cg = CodeGraph.initSync(tmp);
    await cg.indexAll();
    cg.close();

    const reader = CodeSymbolGraph.open(tmp);
    try {
      const a = buildAppGraph(tmp, reader, { platform: 'android' });
      const b = buildAppGraph(tmp, reader, { platform: 'android' });
      expect(canonicalJson(a)).toEqual(canonicalJson(b));
    } finally {
      reader.close();
    }
  });
});
