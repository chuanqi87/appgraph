/**
 * navigates_to / backed_by lifted FROM the core graph (AppGraph A2).
 *
 * The app-semantic navigation edges are derived from the core compose-route /
 * android-intent synthesized edges, not string-scanned from source. Pins:
 *   - compose: navigate("topic") in a screen → Screen→Screen navigates_to
 *   - a navigate one hop behind the screen (a helper it calls) still connects
 *   - android-intent: startActivity → navigates_to, startService → backed_by
 *   - every edge is provenance:'lifted' with attrs.liftedFrom naming the source
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { CodeSymbolGraph } from '../src/appgraph/graph-reader';
import { buildAppGraph } from '../src/appgraph/build';
import { AppEdge, AppNode } from '../src/appgraph/schema';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('navigates_to lifted from core', () => {
  let root: string | undefined;
  let reader: CodeSymbolGraph | undefined;
  afterEach(() => {
    reader?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = reader = undefined;
  });

  it('lifts compose + helper + intent navigation as provenance:lifted', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'navlift-'));
    const w = (rel: string, s: string): void => {
      const f = path.join(root!, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, s, 'utf8');
    };
    w('app/build.gradle.kts', 'dependencies { implementation("androidx.compose.ui:ui") }');
    w(
      'app/src/main/AndroidManifest.xml',
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.x">' +
        '<application>' +
        '<activity android:name=".MainActivity" android:exported="true"><intent-filter>' +
        '<action android:name="android.intent.action.MAIN"/>' +
        '<category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity>' +
        '<activity android:name=".DetailActivity"/>' +
        '<service android:name=".SyncService"/>' +
        '</application></manifest>'
    );
    w(
      'app/src/main/java/com/x/MainActivity.kt',
      `package com.x
import android.app.Activity
import android.content.Intent
class MainActivity : Activity() {
  fun open() { startActivity(Intent(this, DetailActivity::class.java)) }
  fun sync() { startService(Intent(this, SyncService::class.java)) }
}
class DetailActivity : Activity()
class SyncService
`
    );
    w(
      'app/src/main/java/com/x/Nav.kt',
      `package com.x
import androidx.navigation.compose.NavHost
import androidx.compose.runtime.Composable
@Composable fun AppNav(nav: NavHostController) {
  NavHost(nav, startDestination = "feed") {
    composable("feed") { FeedScreen(nav) }
    composable("topic") { TopicScreen() }
    composable("about") { AboutScreen() }
  }
}
@Composable fun FeedScreen(nav: NavHostController) {
  Button(onClick = { nav.navigate("topic") }) {}   // direct
  Button(onClick = { goAbout(nav) }) {}             // one hop behind a helper
}
fun goAbout(nav: NavHostController) { nav.navigate("about") }
@Composable fun TopicScreen() {}
@Composable fun AboutScreen() {}
`
    );

    const cg = CodeGraph.initSync(root);
    await cg.indexAll();
    cg.close();
    reader = CodeSymbolGraph.open(root);
    const graph = buildAppGraph(root, reader, { platform: 'android' });
    const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));

    const edgesOf = (kind: AppEdge['kind']): Array<{ from: string; to: string; lifted: unknown }> =>
      graph.edges
        .filter((e) => e.kind === kind)
        .map((e) => ({ from: byId.get(e.from)?.name ?? e.from, to: byId.get(e.to)?.name ?? e.to, lifted: e.attrs?.liftedFrom }));

    const nav = edgesOf('navigates_to');
    const pair = (from: string, to: string) => nav.find((e) => e.from === from && e.to === to);

    // compose direct + helper-indirection + intent all connect.
    expect(pair('FeedScreen', 'TopicScreen')).toBeTruthy();
    expect(pair('FeedScreen', 'AboutScreen')).toBeTruthy(); // via goAbout helper
    expect(pair('MainActivity', 'DetailActivity')).toBeTruthy();
    // startService → backed_by, not navigates_to.
    expect(pair('MainActivity', 'SyncService')).toBeFalsy();

    // Provenance is lifted, tagged by the core synthesizer.
    expect(pair('FeedScreen', 'TopicScreen')!.lifted).toBe('compose-route');
    expect(pair('MainActivity', 'DetailActivity')!.lifted).toBe('android-intent');

    const backed = edgesOf('backed_by');
    expect(backed.find((e) => e.from === 'MainActivity' && e.to === 'SyncService')).toBeTruthy();

    // Every nav edge is lifted, never source-static.
    const navNodes: AppNode[] = graph.nodes.filter((n) => n.kind === 'Screen');
    expect(navNodes.length).toBeGreaterThan(0);
    expect(graph.edges.filter((e) => e.kind === 'navigates_to').every((e) => e.provenance === 'lifted')).toBe(true);
  });
});
