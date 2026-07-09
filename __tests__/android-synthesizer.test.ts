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

describe('android-fragment synthesis (seam 3d)', () => {
  let root: string | undefined;
  let reader: CodeSymbolGraph | undefined;
  afterEach(() => {
    reader?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = reader = undefined;
  });

  it('links FragmentTransaction .replace/.add, reified KTX and DialogFragment .show to the target', async () => {
    ({ root, reader } = await indexProject({
      'app/src/main/java/com/x/HostActivity.kt': `package com.x
import androidx.fragment.app.FragmentActivity
class HostActivity : FragmentActivity() {
  fun openFeed() {
    supportFragmentManager.beginTransaction().replace(R.id.container, FeedFragment()).commit()
  }
  fun openSettings() {
    supportFragmentManager.beginTransaction().add(R.id.container, SettingsFragment.newInstance()).commit()
  }
  fun openProfile() {
    supportFragmentManager.commit { replace<ProfileFragment>(R.id.container) }
  }
  fun confirm() {
    ConfirmDialog().show(supportFragmentManager, "confirm")
  }
}
class FeedFragment
class SettingsFragment
class ProfileFragment
class ConfirmDialog
`,
    }));
    const pairs = synthPairs(reader!, ['android-fragment']);
    expect(pairs).toContainEqual({ by: 'android-fragment', from: 'openFeed', to: 'FeedFragment' });
    expect(pairs).toContainEqual({ by: 'android-fragment', from: 'openSettings', to: 'SettingsFragment' });
    expect(pairs).toContainEqual({ by: 'android-fragment', from: 'openProfile', to: 'ProfileFragment' });
    expect(pairs).toContainEqual({ by: 'android-fragment', from: 'confirm', to: 'ConfirmDialog' });
  });

  it('precision: an ambiguous fragment class name is dropped', async () => {
    ({ root, reader } = await indexProject({
      'app/src/main/java/com/x/Host.kt': `package com.x
class Host {
  fun go() { supportFragmentManager.beginTransaction().replace(R.id.c, FeedFragment()).commit() }
}
class FeedFragment
`,
      'feature/src/main/java/com/y/Dup.kt': `package com.y
class FeedFragment
`,
    }));
    expect(synthPairs(reader!, ['android-fragment']).filter((p) => p.to === 'FeedFragment')).toEqual([]);
  });

  it('precision: a plain .show() on a non-constructor receiver emits nothing', async () => {
    ({ root, reader } = await indexProject({
      'app/src/main/java/com/x/Toast.kt': `package com.x
class Screen {
  fun toast(builder: SomethingBuilder) { builder.show() } // not a fragment/dialog nav
}
`,
    }));
    expect(synthPairs(reader!, ['android-fragment'])).toEqual([]);
  });

  it('precision: a non-*Fragment/*Dialog target (list.add / builder.show) emits nothing', async () => {
    ({ root, reader } = await indexProject({
      'app/src/main/java/com/x/Misc.kt': `package com.x
class Misc {
  fun build(list: MutableList<Widget>) { list.add(0, Widget()) }   // List.add, not a fragment txn
  fun open() { AlertBuilder().show(this, "x") }                     // builder, not a DialogFragment
}
class Widget
class AlertBuilder
`,
    }));
    expect(synthPairs(reader!, ['android-fragment'])).toEqual([]);
  });
});

describe('compose-state synthesis (seam 3c)', () => {
  let root: string | undefined;
  let reader: CodeSymbolGraph | undefined;
  afterEach(() => {
    reader?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = reader = undefined;
  });

  const VM = `package com.x
import kotlinx.coroutines.flow.MutableStateFlow
class FooViewModel {
  private val _uiState = MutableStateFlow(UiState())
  val uiState = _uiState
  fun refresh() { _uiState.value = UiState(loading = true) }
  fun tweak() { _uiState.update { it.copy(loading = false) } }
  fun readOnly(): Int { return _uiState.value.count }
}
`;

  it('links a state-writing VM method to its collector composables (param + viewModel<T>)', async () => {
    ({ root, reader } = await indexProject({
      'app/src/main/java/com/x/FooViewModel.kt': VM,
      'app/src/main/java/com/x/Screen.kt': `package com.x
import androidx.compose.runtime.Composable
import androidx.lifecycle.viewmodel.compose.viewModel
@Composable fun FeedScreen(vm: FooViewModel) {
  val s = vm.uiState.collectAsState()
  Button(onClick = { vm.refresh() }) {}
}
@Composable fun HomeScreen() {
  val vm: FooViewModel = viewModel()
  val s = vm.uiState.collectAsState()
}
@Composable fun Unrelated() {}
`,
    }));
    const pairs = synthPairs(reader!, ['compose-state']);
    // Both writers reach both collectors (recomposition).
    expect(pairs).toContainEqual({ by: 'compose-state', from: 'refresh', to: 'FeedScreen' });
    expect(pairs).toContainEqual({ by: 'compose-state', from: 'refresh', to: 'HomeScreen' });
    expect(pairs).toContainEqual({ by: 'compose-state', from: 'tweak', to: 'FeedScreen' });
    // A read-only method never recomposes.
    expect(pairs.some((p) => p.from === 'readOnly')).toBe(false);
    // A composable that doesn't collect this VM gets nothing.
    expect(pairs.some((p) => p.to === 'Unrelated')).toBe(false);
  });

  it('precision: a VM feeding more than the fan-out cap of composables is skipped', async () => {
    const screens = Array.from({ length: 9 }, (_, i) =>
      `@Composable fun Screen${i}(vm: BigViewModel) { val s = vm.uiState.collectAsState() }`
    ).join('\n');
    ({ root, reader } = await indexProject({
      'app/src/main/java/com/x/BigViewModel.kt': `package com.x
import kotlinx.coroutines.flow.MutableStateFlow
class BigViewModel {
  private val _uiState = MutableStateFlow(0)
  fun bump() { _uiState.value = 1 }
}
`,
      'app/src/main/java/com/x/Screens.kt': `package com.x
import androidx.compose.runtime.Composable
${screens}
`,
    }));
    // 9 collectors > cap(8) → the whole VM is skipped (app-wide state, not a static pair).
    expect(synthPairs(reader!, ['compose-state'])).toEqual([]);
  });
});
