/**
 * AppGraph → codegraph_explore annotation (the consumer main channel).
 *
 * When a project has a `.appgraph/app-graph.json`, explore output for a symbol
 * that IS an app Screen / launcher entry gets a one-line app-semantic fact
 * appended — "App: Screen 'ForYou' (launcher) — navigates_to: Topic, Settings".
 * This is the "adapt the tool to the agent" surface: the fact rides the tool the
 * agent already calls, no new MCP tool. A project with no `.appgraph/` is a
 * zero-cost silent no-op (the index loads to null and every lookup misses).
 */

import { readFileSync, statSync } from 'node:fs';
import { appGraphPath } from './paths';
import { AppGraph, AppNode } from './schema';

export interface AppGraphIndex {
  /** app-graph.json mtime, for cache invalidation. */
  mtimeMs: number;
  /** platform symbol name (composable / Activity class) → one-line app fact. */
  bySymbol: Map<string, string>;
}

const cache = new Map<string, AppGraphIndex | null>();

/**
 * Load + index a project's app graph, cached by file mtime. Returns null (cached)
 * when the project has no readable `.appgraph/app-graph.json`.
 */
export function loadAppGraphIndex(projectRoot: string): AppGraphIndex | null {
  const path = appGraphPath(projectRoot);
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    cache.set(projectRoot, null);
    return null;
  }
  const cached = cache.get(projectRoot);
  if (cached && cached.mtimeMs === mtimeMs) return cached;

  let graph: AppGraph;
  try {
    graph = JSON.parse(readFileSync(path, 'utf8')) as AppGraph;
  } catch {
    cache.set(projectRoot, null);
    return null;
  }
  const index = buildIndex(graph, mtimeMs);
  cache.set(projectRoot, index);
  return index;
}

/** The app fact for `symbolName`, or null if it is not an indexed Screen/entry. */
export function annotateSymbol(index: AppGraphIndex | null, symbolName: string): string | null {
  return index ? index.bySymbol.get(symbolName) ?? null : null;
}

function buildIndex(graph: AppGraph, mtimeMs: number): AppGraphIndex {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  // navigates_to targets per source screen id → target screen names (sorted, unique).
  const navTargets = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    if (e.kind !== 'navigates_to') continue;
    const to = nodeById.get(e.to);
    if (!to) continue;
    let set = navTargets.get(e.from);
    if (!set) navTargets.set(e.from, (set = new Set()));
    set.add(to.name);
  }

  // A Screen is a launcher when an AppEntry shares its match key (Android's
  // launcher Screen and its AppEntry co-name; Harmony's AppEntry edges to it).
  const launcherKeys = new Set(
    graph.nodes.filter((n) => n.kind === 'AppEntry').map((n) => n.matchKey)
  );

  const bySymbol = new Map<string, string>();
  const put = (symbol: string | undefined, fact: string): void => {
    if (symbol && !bySymbol.has(symbol)) bySymbol.set(symbol, fact);
  };

  for (const node of graph.nodes) {
    if (node.kind === 'Screen') {
      const launcher = launcherKeys.has(node.matchKey) ? ' (launcher)' : '';
      const targets = [...(navTargets.get(node.id) ?? [])].sort();
      const nav = targets.length ? ` — navigates_to: ${targets.join(', ')}` : '';
      put(symbolOf(node), `App: Screen '${node.name}'${launcher}${nav}`);
    } else if (node.kind === 'AppEntry') {
      put(symbolOf(node), `App: launcher entry '${node.name}'`);
    }
  }

  return { mtimeMs, bySymbol };
}

function symbolOf(node: AppNode): string | undefined {
  return node.platformRef?.symbol ?? node.name;
}
