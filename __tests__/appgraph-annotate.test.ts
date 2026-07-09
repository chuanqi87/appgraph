/**
 * AppGraph → explore annotation (the consumer main channel).
 *
 * Builds a real `.appgraph/app-graph.json` for a Compose app, then checks that
 * `loadAppGraphIndex` + `annotateSymbol` surface a one-line app fact for a Screen
 * symbol and stay silent (null) for a project with no app graph.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { CodeSymbolGraph } from '../src/appgraph/graph-reader';
import { buildAppGraph, writeAppGraph } from '../src/appgraph/build';
import { appGraphPath } from '../src/appgraph/paths';
import { loadAppGraphIndex, annotateSymbol } from '../src/appgraph/annotate';
import { ToolHandler } from '../src/mcp/tools';

const SCREENS = `package com.x
import androidx.compose.runtime.Composable
@Composable fun ForYouScreen(nav: NavHostController) {
  Button(onClick = { nav.navigate("topic") }) {}
}
@Composable fun TopicScreen() {}
`;

function scaffold(root: string): void {
  const w = (rel: string, s: string): void => {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, s, 'utf8');
  };
  w('app/build.gradle.kts', 'dependencies { implementation("androidx.compose.ui:ui") }');
  w(
    'app/src/main/AndroidManifest.xml',
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.x">' +
      '<application><activity android:name=".MainActivity" android:exported="true">' +
      '<intent-filter><action android:name="android.intent.action.MAIN"/>' +
      '<category android:name="android.intent.category.LAUNCHER"/></intent-filter>' +
      '</activity></application></manifest>'
  );
  w('app/src/main/java/com/x/Screens.kt', SCREENS);
}

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('AppGraph explore annotation', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('surfaces a Screen fact for a composable symbol; not for a non-screen', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'appgraph-annotate-'));
    scaffold(root);

    const cg = CodeGraph.initSync(root);
    await cg.indexAll();
    cg.close();
    const reader = CodeSymbolGraph.open(root);
    try {
      const graph = buildAppGraph(root, reader, { platform: 'android' });
      writeAppGraph(appGraphPath(root), graph);
    } finally {
      reader.close();
    }

    const index = loadAppGraphIndex(root);
    expect(index).not.toBeNull();

    const fact = annotateSymbol(index, 'ForYouScreen');
    expect(fact).toMatch(/^App: Screen 'ForYouScreen'/);

    // A symbol that is not an app Screen gets nothing.
    expect(annotateSymbol(index, 'Button')).toBeNull();
  });

  it('codegraph_explore appends the app fact for an explored Screen symbol', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'appgraph-explore-'));
    scaffold(root);

    const cg = CodeGraph.initSync(root);
    await cg.indexAll();
    const reader = CodeSymbolGraph.open(root);
    try {
      writeAppGraph(appGraphPath(root), buildAppGraph(root, reader, { platform: 'android' }));
    } finally {
      reader.close();
    }

    const handler = new ToolHandler(cg);
    const res = await handler.execute('codegraph_explore', { query: 'ForYouScreen' });
    const text = res.content[0]!.text;
    expect(text).toContain("App: Screen 'ForYouScreen'");
    cg.destroy();
  });

  it('is a silent no-op when the project has no .appgraph/', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'appgraph-none-'));
    const index = loadAppGraphIndex(root);
    expect(index).toBeNull();
    expect(annotateSymbol(index, 'Anything')).toBeNull();
  });
});
