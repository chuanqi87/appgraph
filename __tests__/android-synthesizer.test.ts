/**
 * Android dynamic-dispatch synthesis (AppGraph seam 3): android-intent +
 * compose-route families, with precision negatives.
 *
 *   android-intent — startActivity/startService(Intent(ctx, X::class.java)) → X.
 *     Negatives: a `::class.java` outside a start* call emits nothing; an
 *     ambiguous class name (two classes of that name) is dropped.
 *   compose-route  — navController.navigate("home" | RouteType) → the route node.
 *     Negatives: an unknown route emits nothing; an ambiguous route is dropped.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-synth-'));
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

/** Synthesized edges of the given tags, projected to `{by, from, to}` names. */
function synthPairs(reader: CodeSymbolGraph, tags: string[]): Array<{ by: string; from: string; to: string }> {
  const byId = new Map(reader.getAllNodes().map((n) => [n.id, n]));
  return reader.getSynthesizedEdges(tags).map((e) => ({
    by: e.synthesizedBy,
    from: byId.get(e.source)?.name ?? e.source,
    to: byId.get(e.target)?.name ?? e.target,
  }));
}

describe('android-intent synthesis (seam 3a)', () => {
  let root: string | undefined;
  let reader: CodeSymbolGraph | undefined;
  afterEach(() => {
    reader?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = reader = undefined;
  });

  it('links startActivity/startService(Intent(_, X::class.java)) to X', async () => {
    ({ root, reader } = await indexProject({
      'app/src/main/java/com/x/MainActivity.kt': `package com.x
import android.app.Activity
import android.content.Intent
class MainActivity : Activity() {
  fun openDetail() { startActivity(Intent(this, DetailActivity::class.java)) }
  fun startSync() { startService(Intent(this, SyncService::class.java)) }
}
class DetailActivity : Activity()
class SyncService
`,
    }));
    const pairs = synthPairs(reader!, ['android-intent']);
    expect(pairs).toContainEqual({ by: 'android-intent', from: 'openDetail', to: 'DetailActivity' });
    expect(pairs).toContainEqual({ by: 'android-intent', from: 'startSync', to: 'SyncService' });
  });

  it('precision: a ::class.java outside a start* call emits no edge', async () => {
    ({ root, reader } = await indexProject({
      'app/src/main/java/com/x/Reg.kt': `package com.x
class Registry {
  fun register() { val t = WorkerJob::class.java } // reflection, not navigation
}
class WorkerJob
`,
    }));
    expect(synthPairs(reader!, ['android-intent'])).toEqual([]);
  });

  it('precision: an ambiguous target class name is dropped', async () => {
    ({ root, reader } = await indexProject({
      'app/src/main/java/com/x/Start.kt': `package com.x
import android.app.Activity
import android.content.Intent
class Launcher : Activity() {
  fun go() { startActivity(Intent(this, DetailActivity::class.java)) }
}
class DetailActivity : Activity()
`,
      'feature/src/main/java/com/y/Other.kt': `package com.y
import android.app.Activity
class DetailActivity : Activity()
`,
    }));
    // Two classes named DetailActivity → ambiguous → no android-intent edge.
    const detail = synthPairs(reader!, ['android-intent']).filter((p) => p.to === 'DetailActivity');
    expect(detail).toEqual([]);
  });
});

describe('compose-route synthesis (seam 3b)', () => {
  let root: string | undefined;
  let reader: CodeSymbolGraph | undefined;
  afterEach(() => {
    reader?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = reader = undefined;
  });

  const NAV = `package com.x
import androidx.navigation.compose.NavHost
import androidx.compose.runtime.Composable
@Composable fun AppNav(nav: NavHostController) {
  NavHost(nav, startDestination = "home") {
    composable("home") { HomeScreen(nav) }
    composable<TopicRoute> { TopicScreen() }
  }
}
@Composable fun HomeScreen(nav: NavHostController) {
  Button(onClick = { nav.navigate("home") }) {}
  Button(onClick = { nav.navigate(TopicRoute(1)) }) {}
}
@Composable fun TopicScreen() {}
class TopicRoute(val id: Int)
`;

  it('links navigate("home") and navigate(TopicRoute) to their route nodes', async () => {
    ({ root, reader } = await indexProject({
      'app/build.gradle.kts': 'dependencies { implementation("androidx.compose.ui:ui") }',
      'app/src/main/java/com/x/Nav.kt': NAV,
    }));
    const pairs = synthPairs(reader!, ['compose-route']);
    expect(pairs).toContainEqual({ by: 'compose-route', from: 'HomeScreen', to: 'home' });
    expect(pairs).toContainEqual({ by: 'compose-route', from: 'HomeScreen', to: 'TopicRoute' });
  });

  it('precision: navigate to an unknown route emits no edge', async () => {
    ({ root, reader } = await indexProject({
      'app/build.gradle.kts': 'dependencies { implementation("androidx.compose.ui:ui") }',
      'app/src/main/java/com/x/Nav.kt': `package com.x
import androidx.compose.runtime.Composable
@Composable fun Screen(nav: NavHostController) {
  Button(onClick = { nav.navigate("does_not_exist") }) {}
}
`,
    }));
    expect(synthPairs(reader!, ['compose-route'])).toEqual([]);
  });
});
