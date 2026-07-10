/**
 * P3.3 · Navigation3 / type-safe route PARAMETER recovery.
 *
 * A `entry<TopicNavKey>` / `composable<TopicRoute>` route is named after its key
 * TYPE, whose primary-constructor fields ARE the destination's parameters. nia
 * declares the key in one module (`:api`) and its entry in another (`:impl`), so
 * the recovery is cross-file — the lift joins them and stamps `routeParams` onto
 * the navigates_to edge, so the target reconstruction knows the screen's inputs.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../src';
import { initGrammars, loadAllGrammars } from '../../src/extraction/grammars';
import { CodeSymbolGraph } from '../../src/appgraph/graph-reader';
import { buildAppGraph } from '../../src/appgraph/build';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('Navigation3 route parameter recovery', () => {
  let root: string | undefined;
  let reader: CodeSymbolGraph | undefined;
  afterEach(() => {
    reader?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = reader = undefined;
  });

  it('stamps routeParams (name: type) from the key data class onto the navigates_to edge', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nav3-params-'));
    const w = (rel: string, s: string): void => {
      const f = path.join(root!, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, s, 'utf8');
    };
    w('app/build.gradle.kts', 'dependencies { implementation("androidx.compose.ui:ui") }');
    w(
      'app/src/main/AndroidManifest.xml',
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.n3">' +
        '<application><activity android:name=".MainActivity" android:exported="true"><intent-filter>' +
        '<action android:name="android.intent.action.MAIN"/>' +
        '<category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity>' +
        '</application></manifest>'
    );
    // The key data class lives in its own file (nia's `:api` module split).
    w(
      'app/src/main/java/com/n3/TopicNavKey.kt',
      `package com.n3
import androidx.navigation3.runtime.NavKey
import kotlinx.serialization.Serializable
@Serializable
data class TopicNavKey(val id: String, val fromDeepLink: Boolean = false) : NavKey
`
    );
    // The topic entry registers TopicScreen for that key.
    w(
      'app/src/main/java/com/n3/TopicEntry.kt',
      `package com.n3
import androidx.compose.runtime.Composable
import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey
fun EntryProviderScope<NavKey>.topicEntry() {
  entry<TopicNavKey> { key -> TopicScreen(key.id) }
}
@Composable fun TopicScreen(id: String) {}
`
    );
    // The home entry navigates to the topic key — the navigate site attributes to
    // HomeScreen via the entry-sibling rule.
    w(
      'app/src/main/java/com/n3/HomeEntry.kt',
      `package com.n3
import androidx.compose.runtime.Composable
import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey
object HomeKey : NavKey
fun EntryProviderScope<NavKey>.homeEntry(navigator: Navigator) {
  entry<HomeKey> { HomeScreen(onTopic = { navigator.navigate(TopicNavKey("t")) }) }
}
@Composable fun HomeScreen(onTopic: () -> Unit) {}
`
    );

    const cg = CodeGraph.initSync(root);
    await cg.indexAll();
    cg.close();
    reader = CodeSymbolGraph.open(root);
    const graph = buildAppGraph(root, reader, { platform: 'android' });
    const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));

    const edge = graph.edges.find(
      (e) =>
        e.kind === 'navigates_to' &&
        byId.get(e.from)?.name === 'HomeScreen' &&
        byId.get(e.to)?.name === 'TopicScreen'
    );
    expect(edge, 'HomeScreen→TopicScreen navigates_to should exist').toBeTruthy();
    expect(edge!.attrs?.liftedFrom).toBe('compose-route');
    expect(edge!.attrs?.routeParams).toEqual([
      { name: 'id', type: 'String' },
      { name: 'fromDeepLink', type: 'Boolean' },
    ]);
  });
});
