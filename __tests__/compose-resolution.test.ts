/**
 * Jetpack Compose Navigation resolution (AppGraph seam 2).
 *
 * Pins the route → destination-composable contract for the NavHost DSL:
 *   - string routes (`composable("home") { HomeScreen() }`)
 *   - type-safe routes (`composable<TopicRoute> { TopicScreen() }`) — what
 *     nowinandroid uses; covering only strings would be a half bridge
 *   - dialogs (`dialog("confirm") { ConfirmDialog() }`)
 * plus the precision negatives: a keyword with no route key emits nothing, and
 * only PascalCase composables (not lowercase helpers) become route targets.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { CodeSymbolGraph } from '../src/appgraph/graph-reader';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

async function indexProject(files: Record<string, string>): Promise<{ root: string; reader: CodeSymbolGraph }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-res-'));
  for (const [rel, src] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, src, 'utf8');
  }
  const cg = CodeGraph.initSync(root);
  await cg.indexAll();
  cg.close();
  return { root, reader: CodeSymbolGraph.open(root) };
}

const SCREENS = `package com.x
import androidx.compose.runtime.Composable
@Composable fun HomeScreen() {}
@Composable fun SettingsScreen() {}
@Composable fun TopicScreen() {}
@Composable fun ConfirmDialog() {}
class TopicRoute
fun logEvent() {}
`;

describe('Compose Navigation resolution', () => {
  let root: string | undefined;
  let reader: CodeSymbolGraph | undefined;
  afterEach(() => {
    reader?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = reader = undefined;
  });

  it('links string, type-safe, and dialog routes to their destination composable', async () => {
    ({ root, reader } = await indexProject({
      'app/build.gradle.kts': 'dependencies { implementation("androidx.compose.ui:ui") }',
      'app/src/main/java/com/x/Nav.kt': `package com.x
import androidx.navigation.compose.NavHost
import androidx.compose.runtime.Composable
@Composable fun AppNav(nav: NavHostController) {
  NavHost(nav, startDestination = "home") {
    composable("home") { HomeScreen() }
    composable("settings") { SettingsScreen() }
    composable<TopicRoute> { TopicScreen() }
    dialog("confirm") { ConfirmDialog() }
  }
}
`,
      'app/src/main/java/com/x/Screens.kt': SCREENS,
    }));

    const nodes = reader!.getAllNodes();
    const edges = reader!.getAllEdges();
    const byId = new Map(nodes.map((n) => [n.id, n]));

    const routeNames = nodes.filter((n) => n.kind === 'route').map((n) => n.name).sort();
    expect(routeNames).toEqual(['TopicRoute', 'confirm', 'home', 'settings']);

    const routeEdge = (routeName: string, target: string): boolean =>
      edges.some((e) => {
        const from = byId.get(e.source);
        const to = byId.get(e.target);
        return from?.kind === 'route' && from.name === routeName && to?.name === target;
      });

    // Every route form connects to its destination composable — no half bridge.
    expect(routeEdge('home', 'HomeScreen')).toBe(true);
    expect(routeEdge('settings', 'SettingsScreen')).toBe(true);
    expect(routeEdge('TopicRoute', 'TopicScreen')).toBe(true); // type-safe
    expect(routeEdge('confirm', 'ConfirmDialog')).toBe(true); // dialog
  });

  it('precision: no route key → no route node; lowercase helpers are not targets', async () => {
    ({ root, reader } = await indexProject({
      'app/build.gradle.kts': 'dependencies { implementation("androidx.compose.ui:ui") }',
      'app/src/main/java/com/x/Nav.kt': `package com.x
import androidx.navigation.compose.NavHost
import androidx.compose.runtime.Composable
@Composable fun AppNav(nav: NavHostController) {
  NavHost(nav, startDestination = "home") {
    composable("home") { logEvent(); HomeScreen() }
    composable(navGraphBuilder) { NestedGraph() }
  }
}
`,
      'app/src/main/java/com/x/Screens.kt': SCREENS,
    }));

    const nodes = reader!.getAllNodes();
    const edges = reader!.getAllEdges();
    const byId = new Map(nodes.map((n) => [n.id, n]));

    // Only the keyed route exists; `composable(navGraphBuilder)` has no key.
    const routeNames = nodes.filter((n) => n.kind === 'route').map((n) => n.name).sort();
    expect(routeNames).toEqual(['home']);

    // The lowercase helper call is never a route target (composables are PascalCase).
    const homeTargets = edges
      .filter((e) => byId.get(e.source)?.name === 'home' && byId.get(e.source)?.kind === 'route')
      .map((e) => byId.get(e.target)?.name);
    expect(homeTargets).toContain('HomeScreen');
    expect(homeTargets).not.toContain('logEvent');
  });
});
