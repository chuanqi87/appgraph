import Graph from 'graphology';
import Sigma from 'sigma';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import louvain from 'graphology-communities-louvain';
import { api } from '../api';
import { buildAppGraphModel, type AppGraphModel } from '../appgraph-model';
import { badge, el, empty, errorBox, link, mount, spinner } from '../render';
import { renderNodeDetail } from './codegraph-node-detail';
import { renderAppNodeDetail } from './appgraph-node-detail';
import { APP_EDGE_STYLES, APP_NODE_STYLES, edgeStyle, nodeColor, nodeSize } from '../visual';
import type { Edge as CgEdge } from '../../../types';
import type { AppEdgeWire, AppNodeWire } from '../../wire-types';

export interface GraphViewOptions {
  source: 'codegraph' | 'appgraph';
  query: URLSearchParams;
}

export type AppViewMode = 'module' | 'screen-flow' | 'feature' | 'capability' | 'all';
type ColorMode = 'kind' | 'community';

/** Force-directed canvas. For CodeGraph: a bounded local subgraph around a
 *  start symbol (expandable by double-click). For AppGraph: the whole
 *  document, sliced into one of several "story" subgraphs (module deps, screen
 *  flow, feature map, capability layer) so the same data tells different
 *  stories. Clicking a node opens the SAME detail panel the table views use
 *  and highlights its 1-hop neighborhood; the legend explains every color/edge. */
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
  for (const n of data.nodes) upsertCgNode(graph, n.id, n.name, n.kind, n.id === start ? 8 : 4);
  addCgEdges(graph, data.edges);

  let colorMode: ColorMode = 'kind';
  let focus: string | null = start;
  const legendEl = el('span', { class: 'field-label' }, []);
  // Declared before the closures that reference it so the forward reference
  // doesn't collapse `renderer`'s inferred type to void (TS control-flow quirk).
  let renderer: Sigma | undefined;
  const refreshFocus = (): void => {
    renderer?.setSetting('nodeReducer', focusReducer(graph, focus));
  };
  const recolor = (): void => {
    applyColorMode(graph, colorMode, legendEl);
    layoutGraph(graph);
    refreshFocus();
    renderer?.refresh();
    void renderer?.getCamera().animatedReset();
  };
  renderer = mountSigma(graph, canvasHost, { focus: null, onNodeClick: (id) => showDetail(id) });
  recolor();

  mount(
    toolbar,
    link('← New search', '#/codegraph/graph'),
    ` · ${data.nodes.length} nodes · ${data.edges.length} edges`,
    data.truncated ? ' · ' : null,
    data.truncated ? el('span', { class: 'badge' }, ['truncated']) : null,
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
    ' · double-click a node to expand · ',
    link('browse as table →', '#/codegraph/nodes')
  );

  const showDetail = (id: string): void => {
    focus = id;
    refreshFocus();
    renderer?.refresh();
    void renderNodeDetail(detail, id);
  };
  showDetail(start);

  // clickNode is wired by mountSigma (via opts.onNodeClick) — only the
  // doubleClick-expand (graph mutation) needs its own handler here.
  renderer.on('doubleClickNode', ({ node }) => {
    void api.subgraph({ start: node, mode: 'impact', depth: 1 }).then((more) => {
      for (const n of more.nodes) upsertCgNode(graph, n.id, n.name, n.kind, 4);
      addCgEdges(graph, more.edges);
      recolor();
    });
  });
}

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
  const view = (query.get('view') as AppViewMode) ?? 'module';
  const { graph: appGraph } = await api.appGraph();
  const model = buildAppGraphModel(appGraph);

  const sub = appSubgraph(model, view);
  const graph = new Graph();
  for (const n of sub.nodes) {
    upsertAppNode(graph, model, n, n.id === focus ? 9 : undefined);
  }
  addAppEdges(graph, sub.edges);

  let colorMode: ColorMode = 'kind';
  const legendEl = el('span', { class: 'field-label' }, []);
  // `focus` can come from the URL (initial) or change on click; keep a mutable
  // local so the reducer reflects the latest focus without a re-mount.
  let currentFocus: string | null = focus ?? null;
  const focusValue = (): string | null => currentFocus;
  // Declared before the closures that reference it (see CodeGraph note above).
  let renderer: Sigma | undefined;
  const refreshFocus = (): void => {
    renderer?.setSetting('nodeReducer', focusReducer(graph, focusValue()));
  };
  const recolor = (): void => {
    applyColorMode(graph, colorMode, legendEl);
    layoutGraph(graph);
    refreshFocus();
    renderer?.refresh();
    void renderer?.getCamera().animatedReset();
  };
  renderer = mountSigma(graph, canvasHost, { focus: focus ?? null, onNodeClick: (id) => showDetail(id) });
  recolor();

  mount(
    toolbar,
    `${sub.nodes.length} nodes · ${sub.edges.length} edges · ${appGraph.app.name} (${appGraph.platform})`,
    ' · view ',
    viewModeSelect(view, (next) => navigateAppGraphGraph(next, currentFocus ?? undefined)),
    ' · color by ',
    colorModeSelect(colorMode, (next) => {
      colorMode = next;
      recolor();
    }),
    legendEl,
    ' · ',
    link('browse as table →', '#/appgraph')
  );

  // A persistent legend panel overlaid on the canvas — explains every node
  // color and edge kind currently in view, since "what does a green edge
  // mean?" is otherwise opaque.
  const legendPanel = legendPanelFor(sub);
  canvasHost.appendChild(legendPanel);

  const showDetail = (id: string): void => {
    currentFocus = id;
    refreshFocus();
    renderer.refresh();
    void renderAppNodeDetail(detail, id);
  };
  if (focus) showDetail(focus);

  // clickNode already wired by mountSigma via opts.onNodeClick.
}

/** The subgraph for an AppGraph view mode. Each mode is a different "story":
 *  module = the architecture (modules + depends_on), screen-flow = the UX
 *  (screens + nav + backed_by), feature = functional clusters, capability =
 *  the cross-platform capability layer, all = the whole document. */
export function appSubgraph(model: AppGraphModel, view: AppViewMode): { nodes: AppNodeWire[]; edges: AppEdgeWire[] } {
  const g = model.graph;
  if (view === 'all') return { nodes: g.nodes, edges: g.edges };

  const kindFilter = (n: AppNodeWire): boolean => {
    switch (view) {
      case 'module':
        return n.kind === 'ArchModule';
      case 'screen-flow':
        return n.kind === 'Screen' || n.kind === 'AppEntry' || n.kind === 'BackgroundComponent';
      case 'feature':
        return n.kind === 'Feature' || n.kind === 'ArchModule';
      case 'capability':
        return n.kind === 'Capability' || n.kind === 'Screen' || n.kind === 'BackgroundComponent' || n.kind === 'Permission';
      default:
        return true;
    }
  };
  const edgeFilter = (e: AppEdgeWire): boolean => {
    switch (view) {
      case 'module':
        return e.kind === 'depends_on';
      case 'screen-flow':
        return e.kind === 'navigates_to' || e.kind === 'backed_by';
      case 'feature':
        return e.kind === 'app_contains' || e.kind === 'depends_on';
      case 'capability':
        return e.kind === 'uses_capability' || e.kind === 'requires_permission';
      default:
        return true;
    }
  };

  const nodeIds = new Set(g.nodes.filter(kindFilter).map((n) => n.id));
  const edges = g.edges.filter((e) => edgeFilter(e) && nodeIds.has(e.from) && nodeIds.has(e.to));
  // Keep only nodes that survive the edge filter (drop isolated nodes for
  // screen-flow/capability, where an isolated screen adds noise).
  const touched = new Set<string>();
  if (view !== 'module') {
    for (const e of edges) {
      touched.add(e.from);
      touched.add(e.to);
    }
  }
  const nodes = g.nodes.filter((n) => (view === 'module' ? nodeIds.has(n.id) : touched.has(n.id)));
  return { nodes, edges };
}

function viewModeSelect(current: AppViewMode, onChange: (v: AppViewMode) => void): HTMLSelectElement {
  const modes: Array<[AppViewMode, string]> = [
    ['module', 'Module graph'],
    ['screen-flow', 'Screen flow'],
    ['feature', 'Feature map'],
    ['capability', 'Capability layer'],
    ['all', 'Everything'],
  ];
  return el(
    'select',
    { onchange: (e) => onChange((e.target as HTMLSelectElement).value as AppViewMode) },
    modes.map(([v, label]) => el('option', { value: v, selected: v === current ? '' : undefined }, [label]))
  );
}

function navigateAppGraphGraph(view: AppViewMode, focus?: string): void {
  const params = new URLSearchParams({ view });
  if (focus) params.set('focus', focus);
  location.hash = `#/appgraph/graph?${params.toString()}`;
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
 * `legendEl`. 'community' runs Louvain on the graph currently on screen and
 * RE-SEEDS node positions around community anchors so same-colored nodes
 * actually group into separated blobs (coloring alone doesn't read as
 * clustered). Re-run after any graph mutation (double-click expand).
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

function seedCommunityPositions(graph: Graph, communities: Record<string, number>): void {
  const communityIds = [...new Set(Object.values(communities))];
  const angleStep = (2 * Math.PI) / Math.max(1, communityIds.length);
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

/** Sigma node reducer: when a `focus` node is set, dim + shrink every node
 *  that isn't the focus or its 1-hop neighbor, so the neighborhood reads as a
 *  highlighted cluster against a faded backdrop. */
function focusReducer(graph: Graph, focus: string | null) {
  if (!focus) return (_node: string, attrs: { color?: string; size?: number }) => attrs;
  const neighbors = new Set<string>([focus]);
  graph.forEachNeighbor(focus, (n) => neighbors.add(n));
  return (_node: string, attrs: { color?: string; size?: number; label?: string }) => {
    if (neighbors.has(_node)) return attrs;
    return { ...attrs, color: '#d0d4da', size: (attrs.size ?? 4) * 0.4, label: undefined } as typeof attrs;
  };
}

function upsertCgNode(graph: Graph, id: string, label: string, kind: string, size: number): void {
  if (graph.hasNode(id)) {
    graph.mergeNode(id, { label, kind, size });
  } else {
    graph.addNode(id, { label, kind, color: categoryColor(kind), size, x: Math.random(), y: Math.random() });
  }
}

function upsertAppNode(graph: Graph, model: AppGraphModel, node: AppNodeWire, sizeOverride?: number): void {
  const size = sizeOverride ?? nodeSize(node, model);
  if (graph.hasNode(node.id)) {
    graph.mergeNode(node.id, { label: node.name, kind: node.kind, size });
  } else {
    graph.addNode(node.id, {
      label: node.name,
      kind: node.kind,
      color: nodeColor(node.kind),
      size,
      x: Math.random(),
      y: Math.random(),
    });
  }
}

function addCgEdges(graph: Graph, edges: CgEdge[]): void {
  for (const e of edges) {
    if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue;
    graph.mergeEdgeWithKey(`${e.source}->${e.target}:${e.kind}`, e.source, e.target, {
      label: e.kind,
      size: 1,
      color: '#94a3b8',
    });
  }
}

/** AppGraph edges get SEMANTIC color + arrow style per kind (see visual.ts).
 *  Directed kinds (navigates_to, depends_on, exposes) render as arrows;
 *  undirected/containment kinds render as plain lines. */
function addAppEdges(graph: Graph, edges: AppEdgeWire[]): void {
  for (const e of edges) {
    if (!graph.hasNode(e.from) || !graph.hasNode(e.to)) continue;
    const style = edgeStyle(e.kind);
    const directed = e.kind === 'navigates_to' || e.kind === 'depends_on' || e.kind === 'exposes';
    graph.mergeEdgeWithKey(e.id, e.from, e.to, {
      label: style.label,
      size: 1,
      color: style.color,
      type: directed ? 'arrow' : 'line',
    });
  }
}

export function layoutGraph(graph: Graph): void {
  forceAtlas2.assign(graph, { iterations: 200, settings: forceAtlas2.inferSettings(graph) });
}

export interface MountOptions {
  focus: string | null;
  onNodeClick: (id: string) => void;
}

/** Mounts a Sigma renderer with sensible defaults + lifecycle cleanup, and
 *  wires the focus reducer so neighborhood highlighting is on from the start. */
function mountSigma(graph: Graph, container: HTMLElement, opts: MountOptions): Sigma {
  container.replaceChildren();
  const renderer = new Sigma(graph, container, {
    labelDensity: 0.07,
    labelGridCellSize: 60,
    labelRenderedSizeThreshold: 6,
    renderEdgeLabels: false,
  });
  renderer.setSetting('nodeReducer', focusReducer(graph, opts.focus));
  renderer.on('clickNode', ({ node }) => opts.onNodeClick(node));
  const disposeOnNavigate = (): void => {
    renderer.kill();
    window.removeEventListener('hashchange', disposeOnNavigate);
  };
  window.addEventListener('hashchange', disposeOnNavigate, { once: true });
  return renderer;
}

/** One-shot mount of an AppGraph subgraph canvas — used by the overview's
 *  centerpiece (modules-only) and reusable for any view mode. Builds the
 *  graphology graph, lays it out, mounts sigma with semantic edge styling +
 *  focus highlight, and overlays the legend. Returns the renderer (caller
 *  usually ignores it — cleanup is wired to hashchange). */
export function mountAppCanvas(
  model: AppGraphModel,
  view: AppViewMode,
  host: HTMLElement,
  opts: { focus?: string | null; onNodeClick: (id: string) => void }
): Sigma {
  const sub = appSubgraph(model, view);
  const graph = new Graph();
  for (const n of sub.nodes) upsertAppNode(graph, model, n, n.id === opts.focus ? 9 : undefined);
  addAppEdges(graph, sub.edges);
  applyColorMode(graph, 'kind', el('span', {}));
  layoutGraph(graph);
  const renderer = mountSigma(graph, host, { focus: opts.focus ?? null, onNodeClick: opts.onNodeClick });
  host.appendChild(legendPanelFor(sub));
  return renderer;
}

/** Builds the overlaid legend panel: a compact grid of the node kinds and
 *  edge kinds currently in the subgraph, so the colors are self-documenting. */
function legendPanelFor(sub: { nodes: AppNodeWire[]; edges: AppEdgeWire[] }): HTMLElement {
  const kinds = [...new Set(sub.nodes.map((n) => n.kind))].sort();
  const edgeKinds = [...new Set(sub.edges.map((e) => e.kind))].sort();

  const swatch = (color: string, dash: 'solid' | 'dashed' | 'dotted', label: string): HTMLElement =>
    el('div', { class: 'legend-item' }, [
      el('span', { class: `legend-swatch legend-swatch-${dash}`, style: `--swatch-color:${color}` }),
      el('span', { class: 'legend-label' }, [label]),
    ]);

  return el('div', { class: 'graph-legend' }, [
    el('div', { class: 'legend-group' }, [
      el('div', { class: 'legend-title' }, ['Nodes']),
      ...kinds.map((k) => swatch(nodeColor(k), 'solid', APP_NODE_STYLES[k]?.label ?? k)),
    ]),
    edgeKinds.length === 0
      ? null
      : el('div', { class: 'legend-group' }, [
          el('div', { class: 'legend-title' }, ['Edges']),
          ...edgeKinds.map((k) => {
            const s = edgeStyle(k);
            return swatch(s.color, s.dash, s.label);
          }),
        ]),
  ]);
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
