/**
 * P3.3 · Slack Circuit navigation coverage (seam 3e).
 *
 * Circuit apps (CatchUp) previously had an EMPTY navigation graph: screens are
 * `… : Screen` classes (not `@Composable` fns) and navigation is
 * `navigator.goTo(XxxScreen)`, both invisible to the platform passes. This pins:
 *   - Circuit Screen nodes recovered by supertype `: Screen` AND `@CircuitInject`;
 *   - `goTo(XxxScreen)` → core `circuit-nav` synthesized edge → Screen→Screen
 *     navigates_to (lifted), attributed to the goTo's colocated screen;
 *   - precision: a dynamic `goTo(event.screen)`, a `goTo` onto a non-Screen class,
 *     and a `Screen`-typed constructor parameter (not a supertype) emit nothing.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../src';
import { initGrammars, loadAllGrammars } from '../../src/extraction/grammars';
import { CodeSymbolGraph } from '../../src/appgraph/graph-reader';
import { buildAppGraph } from '../../src/appgraph/build';
import { detectNavFrameworks } from '../../src/appgraph/detect/nav-frameworks';
import { AppNode } from '../../src/appgraph/schema';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

const FILES: Record<string, string> = {
  'app/build.gradle.kts': 'dependencies { implementation("androidx.compose.ui:ui") }',
  'app/src/main/AndroidManifest.xml':
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.x">' +
    '<application><activity android:name=".MainActivity" android:exported="true"><intent-filter>' +
    '<action android:name="android.intent.action.MAIN"/>' +
    '<category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity>' +
    '</application></manifest>',
  // HomeScreen: a `data object … : Screen` colocated with its presenter, which
  // navigates to two other screens (one constructed, one bare object) + a dynamic
  // target that must be dropped.
  'app/src/main/kotlin/com/x/HomeScreen.kt': `package com.x
import com.slack.circuit.runtime.screen.Screen
import com.slack.circuit.runtime.Navigator
import androidx.compose.runtime.Composable
data object HomeScreen : Screen
class HomeEvent(val screen: Screen)
class HomePresenter(private val navigator: Navigator) {
  fun onEvent(event: HomeEvent) {
    navigator.goTo(SettingsScreen())
    navigator.goTo(BookmarksScreen)
    navigator.goTo(event.screen)     // dynamic — must be dropped
  }
}
@Composable
fun Home(state: Int) {}
`,
  // SettingsScreen: `: Screen` supertype AND a @CircuitInject UI — signal upgrades
  // to circuit-inject.
  'app/src/main/kotlin/com/x/SettingsScreen.kt': `package com.x
import com.slack.circuit.runtime.screen.Screen
import androidx.compose.runtime.Composable
data class SettingsScreen(val showTopAppBar: Boolean = true) : Screen
@CircuitInject(SettingsScreen::class, AppScope::class)
@Composable
fun Settings(state: Int) {}
`,
  // BookmarksScreen: supertype-only signal, and a goTo target.
  'app/src/main/kotlin/com/x/BookmarksScreen.kt': `package com.x
import com.slack.circuit.runtime.screen.Screen
data object BookmarksScreen : Screen
`,
  // Negative: `Screen` here is a CONSTRUCTOR PARAMETER type, not a supertype.
  'app/src/main/kotlin/com/x/DrawerScreen.kt': `package com.x
import com.slack.circuit.runtime.screen.Screen
class DrawerScreen(val screen: Screen)
`,
  // Negative: a `.goTo(` onto a class that is NOT a Screen emits no edge.
  'app/src/main/kotlin/com/x/Pager.kt': `package com.x
class Paginator
class Pager {
  fun scroll(p: Paginator) { p.goTo(Paginator()) }
}
`,
};

async function indexFixture(): Promise<{ root: string; reader: CodeSymbolGraph }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'circuit-nav-'));
  for (const [rel, src] of Object.entries(FILES)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, src, 'utf8');
  }
  const cg = CodeGraph.initSync(root);
  await cg.indexAll();
  cg.close();
  return { root, reader: CodeSymbolGraph.open(root) };
}

describe('Circuit navigation (seam 3e)', () => {
  let root: string | undefined;
  let reader: CodeSymbolGraph | undefined;
  afterEach(() => {
    reader?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = reader = undefined;
  });

  it('synthesizes circuit-nav core edges only for resolvable Screen targets', async () => {
    ({ root, reader } = await indexFixture());
    const byId = new Map(reader!.getAllNodes().map((n) => [n.id, n]));
    const pairs = reader!.getSynthesizedEdges(['circuit-nav']).map((e) => ({
      from: byId.get(e.source)?.name ?? e.source,
      to: byId.get(e.target)?.name ?? e.target,
    }));
    expect(pairs).toContainEqual({ from: 'onEvent', to: 'SettingsScreen' });
    expect(pairs).toContainEqual({ from: 'onEvent', to: 'BookmarksScreen' });
    // dynamic goTo(event.screen) and goTo(Paginator()) (non-Screen) never appear.
    expect(pairs.some((p) => p.to === 'Paginator')).toBe(false);
    expect(pairs.length).toBe(2);
  });

  it('recovers Circuit Screen nodes (supertype + @CircuitInject) and lifts navigates_to', async () => {
    ({ root, reader } = await indexFixture());
    const graph = buildAppGraph(root!, reader!, { platform: 'android' });
    const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));

    const circuitScreens = graph.nodes.filter(
      (n): n is AppNode => n.kind === 'Screen' && n.attrs?.framework === 'circuit'
    );
    const names = circuitScreens.map((n) => n.name).sort();
    expect(names).toContain('HomeScreen');
    expect(names).toContain('SettingsScreen');
    expect(names).toContain('BookmarksScreen');
    // A `Screen`-typed constructor parameter is not a screen.
    expect(names).not.toContain('DrawerScreen');
    // @CircuitInject upgrades SettingsScreen's signal above a bare supertype.
    const settings = circuitScreens.find((n) => n.name === 'SettingsScreen')!;
    expect(settings.attrs?.signal).toBe('circuit-inject');
    const bookmarks = circuitScreens.find((n) => n.name === 'BookmarksScreen')!;
    expect(bookmarks.attrs?.signal).toBe('circuit-screen');

    const nav = graph.edges
      .filter((e) => e.kind === 'navigates_to')
      .map((e) => ({ from: byId.get(e.from)?.name, to: byId.get(e.to)?.name, lifted: e.attrs?.liftedFrom }));
    const home2settings = nav.find((e) => e.from === 'HomeScreen' && e.to === 'SettingsScreen');
    const home2bookmarks = nav.find((e) => e.from === 'HomeScreen' && e.to === 'BookmarksScreen');
    expect(home2settings).toBeTruthy();
    expect(home2settings!.lifted).toBe('circuit-nav');
    expect(home2bookmarks).toBeTruthy();
    // Every nav edge is provenance:lifted.
    expect(graph.edges.filter((e) => e.kind === 'navigates_to').every((e) => e.provenance === 'lifted')).toBe(true);
    // Circuit is NOT reported as an uncovered nav-framework blind spot.
    expect(detectNavFrameworks(reader!.getAllNodes()).frameworks).not.toContain('Circuit');
    expect(graph.navFrameworks).not.toContain('Circuit');
  });
});
