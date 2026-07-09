import Graph from 'graphology';
import Sigma from 'sigma';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import louvain from 'graphology-communities-louvain';
import { api } from '../api';
import { badge, el, empty, errorBox, link, mount, spinner } from '../render';
import { renderNodeDetail } from './codegraph-node-detail';
import { renderAppNodeDetail } from './appgraph-node-detail';
import type { Edge as CgEdge } from '../../../types';
import type { AppEdgeWire } from '../../wire-types';

export interface GraphViewOptions {
  source: 'codegraph' | 'appgraph';
  query: URLSearchParams;
}

type ColorMode = 'kind' | 'community';

/** Force-directed canvas — a local subgraph for CodeGraph (bounded, expandable
 *  by double-clicking a node), or the whole document for AppGraph (small
 *  enough to render in full). Clicking a node opens the SAME detail panel
 *  used by the table views — one field-rendering implementation, two entry
 *  points. */
export async function renderGraphView(container: HTMLElement, opts: GraphViewOptions): Promise<void> {
  const layout = el('div', { class: 'graph-layout' }, [
    el('div', { class: 'graph-toolbar' }, ['Loading…']),
    el('div', { class: 'graph-body' }, [
      el('div', { class: 'graph-canvas' }, [spinner()]),
      el('div', { class: 'view-main' }, [el('div', { class: 'empty-state' }, ['Click a node to see its details'])]),
    ]),
  ]);
  mount(container, layout);

  const toolbar = layout.children[0] as HTMLElement;
  const body = layout.children[1] as HTMLElement;
  const canvasHost = body.children[0] as HTMLElement;
  const detail = body.children[1] as HTMLElement;

  try {
    if (opts.source === 'codegraph') {
      await renderCodeGraphSubgraph(opts.query, toolbar, canvasHost, detail);
    } else {
      await renderAppGraphWhole(opts.query, toolbar, canvasHost, detail);
    }
  } catch (err) {
    mount(canvasHost, errorBox(err instanceof Error ? err.message : String(err)));
  }
}

async function renderCodeGraphSubgraph(
  query: URLSearchParams,
  toolbar: HTMLElement,
  canvasHost: HTMLElement,
  detail: HTMLElement
): Promise<void> {
  const start = query.get('start');
  if (!start) {
    renderCodeGraphSearchLanding(toolbar, canvasHost, detail);
    return;
  }
  const mode = query.get('mode') ?? 'impact';
  const depth = parseInt(query.get('depth') ?? '2', 10) || 2;

  const data = await api.subgraph({ start, mode, depth });

  const graph = new Graph();
  for (const n of data.nodes) upsertNode(graph, n.id, n.name, n.kind, n.id === start ? 8 : 4);
  addEdges(graph, data.edges);

  let colorMode: ColorMode = 'kind';
  let renderer: Sigma | undefined;
  const legendEl = el('span', { class: 'field-label' }, []);
  const recolor = (): void => {
    applyColorMode(graph, colorMode, legendEl);
    layoutGraph(graph);
    renderer?.refresh();
    void renderer?.getCamera().animatedReset();
  };
  recolor();
  renderer = mountSigma(graph, canvasHost);

  mount(
    toolbar,
    link('← New search', '#/codegraph/graph'),
    ` · ${data.nodes.length} nodes · ${data.edges.length} edges`,
    data.truncated ? ' · ' : null,
    data.truncated ? el('span', { class: 'badge' }, ['truncated — showing a capped subset']) : null,
    ' · mode ',
    modeSelect(mode, (next) => navigateCodeGraphGraph(start, next, depth)),
    ' · depth ',
    depthSelect(depth, (next) => navigateCodeGraphGraph(start, mode, next)),
    ' · color by ',
    colorModeSelect(colorMode, (next) => {
      colorMode = next;
      recolor();
    }),
    legendEl,
    ' · double-click a node to expand its neighbors · ',
    link('browse as table →', '#/codegraph/nodes')
  );

  const showDetail = (id: string): void => void renderNodeDetail(detail, id);
  showDetail(start);

  renderer.on('clickNode', ({ node }) => showDetail(node));
  renderer.on('doubleClickNode', ({ node }) => {
    void api.subgraph({ start: node, mode: 'impact', depth: 1 }).then((more) => {
      for (const n of more.nodes) upsertNode(graph, n.id, n.name, n.kind, 4);
      addEdges(graph, more.edges);
      recolor();
    });
  });
}

/** Landing state for the CodeGraph graph tab when no `start` node is chosen
 *  yet — a live symbol search that drops straight into that symbol's graph,
 *  so the graph is reachable in one step instead of routing through the
 *  table view first. There's no whole-repo graph by design (see plan): a
 *  real codebase can have tens of thousands of nodes. */
function renderCodeGraphSearchLanding(toolbar: HTMLElement, canvasHost: HTMLElement, detail: HTMLElement): void {
  mount(toolbar, 'Search for a symbol to explore its graph · ', link('browse as table →', '#/codegraph/nodes'));

  const resultsEl = el('ul', { class: 'result-list' }, []);
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const input = el('input', {
    type: 'search',
    placeholder: 'e.g. UserRepository, handleClick…',
    onkeyup: (e) => {
      const value = (e.target as HTMLInputElement).value;
      if (debounceTimer) clearTimeout(debounceTimer);
      if (value.trim().length < 2) {
        mount(resultsEl);
        return;
      }
      debounceTimer = setTimeout(() => void runSearch(value), 250);
    },
  });

  const runSearch = async (value: string): Promise<void> => {
    const { results } = await api.searchNodes({ q: value, limit: 20 });
    mount(
      resultsEl,
      ...results.map(({ node }) =>
        el(
          'li',
          { class: 'result-item', onclick: () => navigateCodeGraphGraph(node.id, 'impact', 2) },
          [badge(node.kind), ' ', el('span', { class: 'result-name' }, [node.name]), el('div', { class: 'result-path' }, [`${node.filePath}:${node.startLine}`])]
        )
      )
    );
  };

  mount(
    canvasHost,
    el('div', { class: 'graph-search-landing' }, [
      el('div', { class: 'field-label' }, ['Pick a starting symbol — its impact radius renders as a graph you can expand']),
      input,
      resultsEl,
    ])
  );
  mount(detail, empty('Pick a symbol to see its details'));
}

async function renderAppGraphWhole(
  query: URLSearchParams,
  toolbar: HTMLElement,
  canvasHost: HTMLElement,
  detail: HTMLElement
): Promise<void> {
  const focus = query.get('focus') ?? undefined;
  const { graph: appGraph } = await api.appGraph();

  const graph = new Graph();
  for (const n of appGraph.nodes) upsertNode(graph, n.id, n.name, n.kind, n.id === focus ? 8 : 5);
  addAppEdges(graph, appGraph.edges);

  let colorMode: ColorMode = 'kind';
  let renderer: Sigma | undefined;
  const legendEl = el('span', { class: 'field-label' }, []);
  const recolor = (): void => {
    applyColorMode(graph, colorMode, legendEl);
    layoutGraph(graph);
    renderer?.refresh();
    void renderer?.getCamera().animatedReset();
  };
  recolor();
  renderer = mountSigma(graph, canvasHost);

  mount(
    toolbar,
    `${appGraph.nodes.length} nodes · ${appGraph.edges.length} edges · ${appGraph.app.name} (${appGraph.platform})`,
    ' · color by ',
    colorModeSelect(colorMode, (next) => {
      colorMode = next;
      recolor();
    }),
    legendEl,
    ' · ',
    link('browse as table →', '#/appgraph')
  );

  const showDetail = (id: string): void => void renderAppNodeDetail(detail, id);
  if (focus) showDetail(focus);

  renderer.on('clickNode', ({ node }) => showDetail(node));
}

function modeSelect(current: string, onChange: (v: string) => void): HTMLSelectElement {
  return el(
    'select',
    { onchange: (e) => onChange((e.target as HTMLSelectElement).value) },
    ['impact', 'callgraph', 'traverse'].map((m) => el('option', { value: m, selected: m === current ? '' : undefined }, [m]))
  );
}

function depthSelect(current: number, onChange: (v: number) => void): HTMLSelectElement {
  return el(
    'select',
    { onchange: (e) => onChange(parseInt((e.target as HTMLSelectElement).value, 10) || current) },
    [1, 2, 3, 4].map((d) => el('option', { value: String(d), selected: d === current ? '' : undefined }, [String(d)]))
  );
}

function navigateCodeGraphGraph(start: string, mode: string, depth: number): void {
  location.hash = `#/codegraph/graph?start=${encodeURIComponent(start)}&mode=${mode}&depth=${depth}`;
}

function colorModeSelect(current: ColorMode, onChange: (v: ColorMode) => void): HTMLSelectElement {
  return el(
    'select',
    { onchange: (e) => onChange((e.target as HTMLSelectElement).value as ColorMode) },
    [
      el('option', { value: 'kind', selected: current === 'kind' ? '' : undefined }, ['Kind']),
      el('option', { value: 'community', selected: current === 'community' ? '' : undefined }, ['Community']),
    ]
  );
}

/**
 * Recolors every node by the chosen mode and writes a short legend into
 * `legendEl`. 'community' runs Louvain (graphology-communities-louvain —
 * the same algorithm AppGraph's own Feature clustering uses server-side,
 * src/appgraph/community/detect.ts) directly on the graph currently on
 * screen — cheap here since the CodeGraph side is always a bounded subgraph
 * (a few hundred nodes at most) and the AppGraph side is small by nature.
 * Re-run this after any graph mutation (double-click expand) so the
 * partition reflects the current node/edge set, not a stale one.
 *
 * Coloring alone doesn't read as "clustered" — same-colored dots scattered
 * across an organic force layout don't visually group. So community mode
 * also RE-SEEDS every node's position around its community's own anchor
 * point (see seedCommunityPositions) before the caller re-runs forceAtlas2;
 * the subsequent layout pass then relaxes within/between those seeded
 * clusters instead of relaxing from a flat random start, which is what
 * actually produces separated blobs.
 */
function applyColorMode(graph: Graph, mode: ColorMode, legendEl: HTMLElement): void {
  if (mode === 'kind') {
    graph.forEachNode((node, attrs) => {
      graph.setNodeAttribute(node, 'color', categoryColor(String(attrs.kind)));
    });
    legendEl.textContent = '';
    return;
  }
  const result = louvain.detailed(graph);
  graph.forEachNode((node) => {
    graph.setNodeAttribute(node, 'color', categoryColor(`c${result.communities[node]}`));
  });
  seedCommunityPositions(graph, result.communities);
  legendEl.textContent = ` · ${result.count} communities · modularity ${result.modularity.toFixed(2)}`;
}

/** Places each node near its community's anchor on a ring, communities
 *  spaced around the ring in detection order. ForceAtlas2 then relaxes edges
 *  within that seed rather than from scratch, so communities settle as
 *  separated blobs instead of an undifferentiated cloud. */
function seedCommunityPositions(graph: Graph, communities: Record<string, number>): void {
  const communityIds = [...new Set(Object.values(communities))];
  const angleStep = (2 * Math.PI) / Math.max(1, communityIds.length);
  // Ring radius grows with community count so more clusters don't overlap;
  // per-cluster jitter radius grows with that cluster's own member count so
  // a big community isn't squeezed into the same tiny circle as a singleton.
  const ringRadius = 12 + communityIds.length * 4;
  const memberCounts = new Map<number, number>();
  for (const id of Object.values(communities)) memberCounts.set(id, (memberCounts.get(id) ?? 0) + 1);

  const centers = new Map<number, { x: number; y: number }>();
  communityIds.forEach((id, i) => {
    const angle = i * angleStep;
    centers.set(id, { x: Math.cos(angle) * ringRadius, y: Math.sin(angle) * ringRadius });
  });

  graph.forEachNode((node) => {
    const communityId = communities[node];
    const center = centers.get(communityId) ?? { x: 0, y: 0 };
    const jitter = 1 + Math.sqrt(memberCounts.get(communityId) ?? 1);
    graph.setNodeAttribute(node, 'x', center.x + (Math.random() - 0.5) * jitter);
    graph.setNodeAttribute(node, 'y', center.y + (Math.random() - 0.5) * jitter);
  });
}

function upsertNode(graph: Graph, id: string, label: string, kind: string, size: number): void {
  if (graph.hasNode(id)) {
    graph.mergeNode(id, { label, kind, size });
  } else {
    graph.addNode(id, { label, kind, color: categoryColor(kind), size, x: Math.random(), y: Math.random() });
  }
}

function addEdges(graph: Graph, edges: CgEdge[]): void {
  for (const e of edges) {
    if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue;
    graph.mergeEdgeWithKey(`${e.source}->${e.target}:${e.kind}`, e.source, e.target, {
      label: e.kind,
      size: 1,
      color: '#94a3b8',
    });
  }
}

function addAppEdges(graph: Graph, edges: AppEdgeWire[]): void {
  for (const e of edges) {
    if (!graph.hasNode(e.from) || !graph.hasNode(e.to)) continue;
    graph.mergeEdgeWithKey(e.id, e.from, e.to, { label: e.kind, size: 1, color: '#94a3b8' });
  }
}

function layoutGraph(graph: Graph): void {
  // More iterations than the plain-organic case: community mode seeds nodes
  // in per-cluster rings first (seedCommunityPositions) and needs the extra
  // passes to relax edges within/between those rings into clean blobs
  // instead of stopping mid-settle.
  forceAtlas2.assign(graph, { iterations: 200, settings: forceAtlas2.inferSettings(graph) });
}

function mountSigma(graph: Graph, container: HTMLElement): Sigma {
  container.replaceChildren();
  const renderer = new Sigma(graph, container);
  // Best-effort cleanup: an abandoned renderer keeps a render loop + window
  // listeners alive after navigating away, since nothing else references it.
  const disposeOnNavigate = (): void => {
    renderer.kill();
    window.removeEventListener('hashchange', disposeOnNavigate);
  };
  window.addEventListener('hashchange', disposeOnNavigate, { once: true });
  return renderer;
}

// Shared by both coloring modes: a node "kind" and a Louvain community id are
// both just categorical keys that need a stable, distinct-ish color.
const CATEGORY_COLORS = new Map<string, string>();
const PALETTE = ['#2f6fed', '#e0954f', '#4caf7d', '#c25be0', '#e0524f', '#4fb6e0', '#b8a13a', '#8c8c8c'];
function categoryColor(key: string): string {
  let color = CATEGORY_COLORS.get(key);
  if (!color) {
    color = PALETTE[CATEGORY_COLORS.size % PALETTE.length] ?? '#8c8c8c';
    CATEGORY_COLORS.set(key, color);
  }
  return color;
}
