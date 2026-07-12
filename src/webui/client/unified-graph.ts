/**
 * Unified semantic-zoom graph view.
 *
 * One canvas, three levels — zoom out to see migration units (Level 0),
 * medium zoom shows modules (Level 1), zoom in to see code symbols
 * (Level 2). Double-click expands/collapses a node into its children.
 *
 * Uses vis-network with Barnes-Hut physics for animated, "alive" nodes
 * (replacing the old static Sigma + ForceAtlas2 setup).
 */

import { DataSet, Network } from 'vis-network/standalone/esm/vis-network.mjs';
import { api, type StatusResponse, type DirSubgraphResponse } from './api';
import { buildAppGraphModel, type AppGraphModel, outgoing, incoming, owningModule } from './appgraph-model';
import {
  buildMigrationModel,
  type MigrationModel,
  unitStatus,
  unitModules,
  unitDependencies,
  unitDependents,
} from './migration-model';
import {
  PALETTE,
  unitColor,
  moduleColorByUnit,
  moduleColorByKind,
  symbolColor,
  cgEdgeColor,
  appEdgeStyle,
  type VisColor,
} from './unified-colors';
import { MIGRATION_STATUS_STYLES, migrationStatusColor, migrationStatusLabel } from './visual';
import { el, mount, empty, errorBox, spinner } from './render';
import type {
  AppNodeWire,
  AppEdgeWire,
  MigrationUnitWire,
  MigrationGraphWire,
  LedgerStatusWire,
  LedgerWire,
} from '../wire-types';
import type { Node as CgNode, Edge as CgEdge } from '../../types';
import { renderDetailPanel } from './detail-panel';
import { renderSidebar, type SidebarCallbacks } from './sidebar';
import { renderNodeList, type NodeListCallbacks } from './node-list';

// vis-network node/edge shapes (our own types to avoid name clashes with CgNode)
interface VNode {
  id: string;
  label: string;
  color?: VisColor;
  shape?: string;
  size?: number;
  value?: number;
  font?: { size?: number; color?: string };
  title?: string;
  borderWidth?: number;
  shadow?: { enabled: boolean; color: string; size: number; x: number; y: number };
  x?: number;
  y?: number;
  hidden?: boolean;
  _level?: number;
  _kind?: string;
  _data?: unknown;
}

interface VEdge {
  id: string;
  from: string;
  to: string;
  arrows?: string;
  color?: { color: string; highlight: string; opacity?: number };
  width?: number;
  smooth?: { type: string; roundness?: number };
  dashes?: boolean | number[];
}

type Level = 0 | 1 | 2;

const ZOOM_THRESHOLD_L0 = 0.5;
const ZOOM_THRESHOLD_L1 = 2.0;
const PHYSICS_OPTIONS = {
  physics: {
    barnesHut: {
      gravitationalConstant: -12000,
      springLength: 90,
      springConstant: 0.02,
      damping: 0.35,
    },
    stabilization: { iterations: 250 },
  },
  interaction: { hover: true, tooltipDelay: 120, navigationButtons: false },
  layout: { improvedLayout: true },
  nodes: { shape: 'dot', borderWidth: 1, font: { color: '#1a1a1a' } },
  edges: {
    arrows: { to: { enabled: true, scaleFactor: 0.5 } },
    color: { opacity: 0.6 },
    smooth: { type: 'continuous', roundness: 0.5 },
  },
};

interface GraphState {
  status: StatusResponse;
  migrationModel: MigrationModel | null;
  appModel: AppGraphModel | null;
  level2Cache: Map<string, DirSubgraphResponse>;
  currentLevel: Level;
  selectedNodeId: string | null;
  focusedModuleId: string | null;
  physicsEnabled: boolean;
  disabledCategories: Set<string>;
  searchText: string;
}

export async function renderUnifiedGraph(container: HTMLElement): Promise<void> {
  container.innerHTML = '';
  container.appendChild(spinner());

  let status: StatusResponse;
  try {
    status = await api.status();
  } catch (err) {
    mount(container, errorBox(`Failed to load status: ${err instanceof Error ? err.message : String(err)}`));
    return;
  }

  let migrationModel: MigrationModel | null = null;
  let appModel: AppGraphModel | null = null;

  if (status.migration.built) {
    try {
      const [mg, ld] = await Promise.all([api.migrationGraph(), api.migrationLedger()]);
      if (mg.graph) {
        migrationModel = buildMigrationModel(mg.graph, ld.ledger);
        appModel = migrationModel.appModel;
      }
    } catch { /* fall through */ }
  }
  if (!appModel && status.appgraph.built) {
    try {
      const ag = await api.appGraph();
      appModel = buildAppGraphModel(ag.graph);
    } catch { /* fall through */ }
  }

  if (!migrationModel && !appModel) {
    // Level 2 (code symbols) always zooms in FROM a module — it has no
    // standalone entry point, so without a migration/app graph there is no
    // module to focus and nothing would ever render. Say so explicitly
    // instead of silently mounting a permanently empty canvas.
    const message = status.codegraph.indexed
      ? `CodeGraph is indexed (${status.codegraph.stats?.nodeCount ?? 0} symbols), but no AppGraph or migration data was found. Run "appgraph build" in this project to see the module/screen graph.`
      : 'No graph data available. Run "appgraph build" or "codegraph index" first.';
    mount(container, empty(message));
    return;
  }

  const state: GraphState = {
    status,
    migrationModel,
    appModel,
    level2Cache: new Map(),
    currentLevel: -1 as Level,
    selectedNodeId: null,
    focusedModuleId: null,
    physicsEnabled: true,
    disabledCategories: new Set(),
    searchText: '',
  };

  renderGraphUI(container, state);
}

function renderGraphUI(container: HTMLElement, state: GraphState): void {
  const layout = el('div', { class: 'flex h-screen overflow-hidden' }, []);

  const sidebarHost = el('aside', { class: 'sidebar scrollbar-thin' }, []);
  const graphWrap = el('div', { class: 'graph-wrap' }, []);
  const listHost = el('aside', { class: 'node-list-panel scrollbar-thin' }, []);

  layout.append(sidebarHost, graphWrap, listHost);
  mount(container, layout);

  const graphCanvas = el('div', { class: 'graph-canvas' }, []);
  const detailHost = el('div', { class: 'detail-float hidden' }, []);
  const levelIndicator = el('div', { class: 'level-indicator' }, ['Loading…']);
  const toggleListBtn = el('button', { class: 'toggle-list-btn' }, ['Hide list ›']);

  graphWrap.append(graphCanvas, detailHost, levelIndicator, toggleListBtn);

  const nodesDS = new DataSet<VNode>([]);
  const edgesDS = new DataSet<VEdge>([]);

  // Cast data to any — vis-network's internal types for Edge.smooth differ
  // from our VEdge interface, but the runtime shapes are compatible.
  const network = new Network(
    graphCanvas,
    { nodes: nodesDS, edges: edgesDS } as never,
    { ...PHYSICS_OPTIONS } as never,
  );

  let listCollapsed = false;
  toggleListBtn.addEventListener('click', () => {
    listCollapsed = !listCollapsed;
    listHost.classList.toggle('collapsed', listCollapsed);
    toggleListBtn.textContent = listCollapsed ? '‹ Show list' : 'Hide list ›';
  });

  const sidebarCallbacks: SidebarCallbacks = {
    onFit: () => network.fit({ animation: true }),
    onTogglePhysics: () => {
      state.physicsEnabled = !state.physicsEnabled;
      network.setOptions({ physics: state.physicsEnabled });
    },
    onLevelSelect: (level: number) => switchToLevel(state, level as Level, nodesDS, edgesDS, network, levelIndicator, detailHost, sidebarHost, listHost),
    onSearch: (text: string) => {
      state.searchText = text;
      applyFilters(nodesDS, edgesDS, state);
    },
    onToggleCategory: (cat: string) => {
      if (state.disabledCategories.has(cat)) state.disabledCategories.delete(cat);
      else state.disabledCategories.add(cat);
      applyFilters(nodesDS, edgesDS, state);
    },
  };

  const nodeListCallbacks: NodeListCallbacks = {
    onNodeClick: (id: string) => {
      network.selectNodes([id]);
      network.focus(id, { scale: 1.3, animation: { duration: 400, easingFunction: "easeInOutQuad" } });
      state.selectedNodeId = id;
      showDetail(state, id, detailHost, sidebarHost);
    },
  };

  network.on('click', (params: { nodes: string[] }) => {
    if (params.nodes.length > 0) {
      const id = params.nodes[0];
      state.selectedNodeId = id;
      showDetail(state, id, detailHost, sidebarHost);
    } else {
      state.selectedNodeId = null;
      detailHost.classList.add('hidden');
    }
  });

  network.on('doubleClick', (params: { nodes: string[] }) => {
    if (params.nodes.length > 0) {
      handleDoubleClick(state, params.nodes[0], nodesDS, edgesDS, network, levelIndicator, detailHost, sidebarHost, listHost);
    }
  });

  let zoomTimer: ReturnType<typeof setTimeout> | null = null;
  network.on('zoom', () => {
    if (zoomTimer) clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => {
      const scale = network.getScale();
      let newLevel: Level;
      if (scale < ZOOM_THRESHOLD_L0) newLevel = 0;
      else if (scale < ZOOM_THRESHOLD_L1) newLevel = 1;
      else newLevel = 2;

      if (newLevel !== state.currentLevel) {
        switchToLevel(state, newLevel, nodesDS, edgesDS, network, levelIndicator, detailHost, sidebarHost, listHost);
      }
    }, 300);
  });

  network.once('stabilizationIterationsDone', () => {
    updateSidebar(state, sidebarHost, sidebarCallbacks);
  });

  const initialLevel: Level = state.migrationModel ? 0 : state.appModel ? 1 : 2;
  switchToLevel(state, initialLevel, nodesDS, edgesDS, network, levelIndicator, detailHost, sidebarHost, listHost);
}

function switchToLevel(
  state: GraphState,
  level: Level,
  nodesDS: DataSet<VNode>,
  edgesDS: DataSet<VEdge>,
  network: Network,
  levelIndicator: HTMLElement,
  detailHost: HTMLElement,
  sidebarHost: HTMLElement,
  listHost: HTMLElement,
): void {
  if (state.currentLevel === level) return;

  const hasLevel0 = state.migrationModel !== null;
  const hasLevel1 = state.appModel !== null;
  const hasLevel2 = state.status.codegraph.indexed;

  if (level === 0 && !hasLevel0) level = 1;
  if (level === 1 && !hasLevel1) level = 0;
  if (level === 2 && !hasLevel2) level = 1;
  if (level === 1 && !hasLevel1 && hasLevel0) level = 0;
  if (level === 1 && !hasLevel1 && hasLevel2) level = 2;

  state.currentLevel = level;

  const positions = getCurrentPositions(network);

  let visNodes: VNode[];
  let visEdges: VEdge[];

  if (level === 0) {
    ({ visNodes, visEdges } = buildLevel0Data(state, positions));
  } else if (level === 1) {
    ({ visNodes, visEdges } = buildLevel1Data(state, positions));
  } else {
    const result = buildLevel2Data(state, positions);
    visNodes = result.visNodes;
    visEdges = result.visEdges;
  }

  nodesDS.clear();
  edgesDS.clear();
  nodesDS.add(visNodes);
  edgesDS.add(visEdges);

  network.stabilize();
  updateLevelIndicator(levelIndicator, level, state);
  detailHost.classList.add('hidden');
  state.selectedNodeId = null;

  updateSidebar(state, sidebarHost, {
    onFit: () => network.fit({ animation: true }),
    onTogglePhysics: () => {
      state.physicsEnabled = !state.physicsEnabled;
      network.setOptions({ physics: state.physicsEnabled });
    },
    onLevelSelect: (l: number) => switchToLevel(state, l as Level, nodesDS, edgesDS, network, levelIndicator, detailHost, sidebarHost, listHost),
    onSearch: (text: string) => {
      state.searchText = text;
      applyFilters(nodesDS, edgesDS, state);
    },
    onToggleCategory: (cat: string) => {
      if (state.disabledCategories.has(cat)) state.disabledCategories.delete(cat);
      else state.disabledCategories.add(cat);
      applyFilters(nodesDS, edgesDS, state);
    },
  });

  updateNodeList(state, listHost, {
    onNodeClick: (id: string) => {
      network.selectNodes([id]);
      network.focus(id, { scale: 1.3, animation: { duration: 400, easingFunction: "easeInOutQuad" } });
      state.selectedNodeId = id;
      showDetail(state, id, detailHost, sidebarHost);
    },
  });
}

interface VisData {
  visNodes: VNode[];
  visEdges: VEdge[];
}

function buildLevel0Data(state: GraphState, positions: Map<string, { x: number; y: number }>): VisData {
  const model = state.migrationModel!;
  const visNodes: VNode[] = [];
  const visEdges: VEdge[] = [];

  const unitIndexMap = new Map<string, number>();
  model.units.forEach((u, i) => unitIndexMap.set(u.id, i));

  for (const unit of model.units) {
    const status = unitStatus(model, unit.id);
    const vc = unitColor(status);
    const moduleCount = unit.moduleIds.length;
    const pos = positions.get(unit.id);
    const node: VNode = {
      id: unit.id,
      label: unit.label || unit.id,
      color: vc,
      shape: 'dot',
      value: Math.max(8, 10 + moduleCount * 3),
      font: { size: 13 },
      borderWidth: moduleCount > 1 ? 3 : 1,
      title: buildUnitTooltip(unit, status, model),
      _level: 0,
      _kind: status,
      _data: unit,
    };
    if (pos) { node.x = pos.x; node.y = pos.y; }
    visNodes.push(node);

    if (unit.dependsOn) {
      for (const depId of unit.dependsOn) {
        visEdges.push({
          id: `${unit.id}->${depId}`,
          from: unit.id,
          to: depId,
          arrows: 'to',
          color: { color: '#cfd3d8', highlight: '#5b9dff', opacity: 0.6 },
          width: 1.5,
          dashes: unit.necessity === 'dev-only',
        });
      }
    }
  }

  return { visNodes, visEdges };
}

function buildLevel1Data(state: GraphState, positions: Map<string, { x: number; y: number }>): VisData {
  const model = state.appModel!;
  const migration = state.migrationModel;
  const visNodes: VNode[] = [];
  const visEdges: VEdge[] = [];

  const modules = model.topLevelNodes;
  const unitColorMap = new Map<string, number>();
  if (migration) {
    migration.units.forEach((u, i) => unitColorMap.set(u.id, i));
  }

  for (const mod of modules) {
    let vc: VisColor;
    if (migration) {
      const unitId = migration.moduleToUnit.get(mod.id);
      if (unitId !== undefined) {
        const idx = unitColorMap.get(unitId) ?? 0;
        vc = moduleColorByUnit(idx);
      } else {
        vc = moduleColorByKind(mod.kind);
      }
    } else {
      vc = moduleColorByKind(mod.kind);
    }

    const sc = typeof mod.attrs?.symbolCount === 'number' ? mod.attrs.symbolCount : 0;
    const pos = positions.get(mod.id);
    const node: VNode = {
      id: mod.id,
      label: mod.name,
      color: vc,
      shape: 'dot',
      value: Math.max(6, 8 + Math.min(14, Math.sqrt(sc))),
      font: { size: 12 },
      borderWidth: 1,
      title: buildModuleTooltip(mod, model, migration),
      _level: 1,
      _kind: mod.kind,
      _data: mod,
    };
    if (pos) { node.x = pos.x; node.y = pos.y; }
    visNodes.push(node);
  }

  const seen = new Set<string>();
  for (const e of model.graph.edges) {
    if (e.kind !== 'depends_on') continue;
    if (!model.byId.has(e.from) || !model.byId.has(e.to)) continue;
    const key = `${e.from}->${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const es = appEdgeStyle(e.kind);
    visEdges.push({
      id: e.id,
      from: e.from,
      to: e.to,
      arrows: 'to',
      color: { color: es.color, highlight: '#5b9dff', opacity: 0.5 },
      width: 1.5,
      dashes: es.dash === 'dashed',
    });
  }

  return { visNodes, visEdges };
}

function buildLevel2Data(state: GraphState, positions: Map<string, { x: number; y: number }>): VisData {
  const appModel = state.appModel;
  if (!appModel) return { visNodes: [], visEdges: [] };

  let moduleId = state.focusedModuleId;
  if (!moduleId) {
    const center = positions.size > 0 ? Array.from(positions.values())[0] : { x: 0, y: 0 };
    let minDist = Infinity;
    for (const [id, pos] of positions) {
      const d = (pos.x - center.x) ** 2 + (pos.y - center.y) ** 2;
      if (d < minDist) { minDist = d; moduleId = id; }
    }
  }
  if (!moduleId) return { visNodes: [], visEdges: [] };

  const mod = appModel.byId.get(moduleId);
  if (!mod) return { visNodes: [], visEdges: [] };

  const dir = typeof mod.attrs?.dir === 'string' ? mod.attrs.dir : '';
  if (!dir) return { visNodes: [], visEdges: [] };

  const cached = state.level2Cache.get(moduleId);
  const data = cached ?? { visNodes: [], visEdges: [] } as unknown as DirSubgraphResponse;

  if (!cached) {
    return { visNodes: [], visEdges: [] };
  }

  const visNodes: VNode[] = [];
  const visEdges: VEdge[] = [];
  const modPos = positions.get(moduleId) ?? { x: 0, y: 0 };

  const inDeg: Record<string, number> = {};
  for (const e of data.edges) {
    inDeg[e.target] = (inDeg[e.target] ?? 0) + 1;
  }

  for (const node of data.nodes) {
    const vc = symbolColor(node.kind);
    const deg = inDeg[node.id] ?? 0;
    const offsetX = (Math.random() - 0.5) * 100;
    const offsetY = (Math.random() - 0.5) * 100;
    visNodes.push({
      id: node.id,
      label: node.name,
      color: vc,
      shape: 'dot',
      value: Math.max(4, 6 + Math.min(10, deg * 2)),
      font: { size: 10, color: '#555' },
      borderWidth: 1,
      title: `<b>${node.name}</b><br/>Kind: ${node.kind}<br/>File: ${node.filePath}:${node.startLine}`,
      _level: 2,
      _kind: node.kind,
      _data: node,
      x: modPos.x + offsetX,
      y: modPos.y + offsetY,
    });
  }

  for (const edge of data.edges) {
    visEdges.push({
      id: `${edge.source}->${edge.target}:${edge.kind}`,
      from: edge.source,
      to: edge.target,
      arrows: 'to',
      color: { color: cgEdgeColor(edge.kind), highlight: '#5b9dff', opacity: 0.4 },
      width: 1,
      smooth: { type: 'continuous', roundness: 0.5 },
    });
  }

  return { visNodes, visEdges };
}

async function loadLevel2Data(state: GraphState, moduleId: string): Promise<DirSubgraphResponse | null> {
  if (state.level2Cache.has(moduleId)) return state.level2Cache.get(moduleId)!;

  const mod = state.appModel?.byId.get(moduleId);
  if (!mod) return null;
  const dir = typeof mod.attrs?.dir === 'string' ? mod.attrs.dir : '';
  if (!dir) return null;

  try {
    const data = await api.dirSubgraph(dir, 500);
    state.level2Cache.set(moduleId, data);
    return data;
  } catch {
    return null;
  }
}

async function handleDoubleClick(
  state: GraphState,
  nodeId: string,
  nodesDS: DataSet<VNode>,
  edgesDS: DataSet<VEdge>,
  network: Network,
  levelIndicator: HTMLElement,
  detailHost: HTMLElement,
  sidebarHost: HTMLElement,
  listHost: HTMLElement,
): Promise<void> {
  if (state.currentLevel === 0) {
    const unit = state.migrationModel?.unitById.get(nodeId);
    if (unit && unit.moduleIds.length > 0) {
      state.focusedModuleId = null;
      switchToLevel(state, 1, nodesDS, edgesDS, network, levelIndicator, detailHost, sidebarHost, listHost);
      const firstModId = unit.moduleIds[0];
      network.focus(firstModId, { scale: 1.0, animation: { duration: 500, easingFunction: "easeInOutQuad" } });
    }
  } else if (state.currentLevel === 1) {
    const mod = state.appModel?.byId.get(nodeId);
    if (mod && state.status.codegraph.indexed) {
      state.focusedModuleId = nodeId;
      const data = await loadLevel2Data(state, nodeId);
      if (data) {
        const positions = getCurrentPositions(network);
        switchToLevel(state, 2, nodesDS, edgesDS, network, levelIndicator, detailHost, sidebarHost, listHost);
        network.focus(nodeId, { scale: 2.5, animation: { duration: 500, easingFunction: "easeInOutQuad" } });
      }
    }
  } else if (state.currentLevel === 2) {
    switchToLevel(state, 1, nodesDS, edgesDS, network, levelIndicator, detailHost, sidebarHost, listHost);
  }
}

function showDetail(state: GraphState, nodeId: string, detailHost: HTMLElement, sidebarHost: HTMLElement): void {
  detailHost.classList.remove('hidden');
  const data = getNodeData(state, nodeId);
  renderDetailPanel(detailHost, state.currentLevel, nodeId, data, state);
}

function getNodeData(state: GraphState, nodeId: string): unknown {
  if (state.currentLevel === 0 && state.migrationModel) {
    return state.migrationModel.unitById.get(nodeId);
  }
  if (state.currentLevel === 1 && state.appModel) {
    return state.appModel.byId.get(nodeId);
  }
  if (state.currentLevel === 2 && state.focusedModuleId) {
    const cached = state.level2Cache.get(state.focusedModuleId);
    return cached?.nodes.find((n) => n.id === nodeId);
  }
  return null;
}

function getCurrentPositions(network: Network): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const canvasNodes = network.getPositions();
  for (const [id, pos] of Object.entries(canvasNodes)) {
    positions.set(id, { x: pos.x, y: pos.y });
  }
  return positions;
}

function updateLevelIndicator(el: HTMLElement, level: Level, state: GraphState): void {
  const labels = ['Level 0: Migration Units', 'Level 1: Modules', 'Level 2: Code Symbols'];
  el.textContent = labels[level];
}

function updateSidebar(state: GraphState, host: HTMLElement, callbacks: SidebarCallbacks): void {
  renderSidebar(host, state, callbacks);
}

function updateNodeList(state: GraphState, host: HTMLElement, callbacks: NodeListCallbacks): void {
  const nodes = getVisibleNodes(state);
  renderNodeList(host, state.currentLevel, nodes, callbacks);
}

function getVisibleNodes(state: GraphState): Array<{ id: string; label: string; kind: string; color: string; data?: unknown }> {
  if (state.currentLevel === 0 && state.migrationModel) {
    return state.migrationModel.units.map((u) => ({
      id: u.id,
      label: u.label || u.id,
      kind: unitStatus(state.migrationModel!, u.id),
      color: migrationStatusColor(unitStatus(state.migrationModel!, u.id)),
      data: u,
    }));
  }
  if (state.currentLevel === 1 && state.appModel) {
    const migration = state.migrationModel;
    return state.appModel.topLevelNodes.map((m) => {
      let color = moduleColorByKind(m.kind).background;
      if (migration) {
        const unitId = migration.moduleToUnit.get(m.id);
        if (unitId) {
          const idx = migration.units.findIndex((u) => u.id === unitId);
          color = PALETTE[idx % PALETTE.length];
        }
      }
      return { id: m.id, label: m.name, kind: m.kind, color, data: m };
    });
  }
  if (state.currentLevel === 2 && state.focusedModuleId) {
    const cached = state.level2Cache.get(state.focusedModuleId);
    if (cached) {
      return cached.nodes.map((n) => ({
        id: n.id,
        label: n.name,
        kind: n.kind,
        color: symbolColor(n.kind).background,
        data: n,
      }));
    }
  }
  return [];
}

function applyFilters(nodesDS: DataSet<VNode>, edgesDS: DataSet<VEdge>, state: GraphState): void {
  const updates: Array<{ id: string; hidden?: boolean }> = [];
  for (const node of nodesDS.get()) {
    const vNode = node as VNode;
    let hidden = false;
    if (state.disabledCategories.has(vNode._kind ?? '')) hidden = true;
    if (state.searchText) {
      const label = vNode.label.toLowerCase();
      if (!label.includes(state.searchText.toLowerCase())) hidden = true;
    }
    updates.push({ id: vNode.id, hidden });
  }
  nodesDS.update(updates as VNode[]);
}

function buildUnitTooltip(unit: MigrationUnitWire, status: LedgerStatusWire, model: MigrationModel): string {
  const mods = unitModules(model, unit.id);
  const deps = unitDependencies(model, unit.id);
  const lines = [
    `<b>${unit.label || unit.id}</b>`,
    `Status: ${migrationStatusLabel(status)}`,
    `Modules: ${mods.length}`,
    `Order: #${unit.order}${unit.cyclic ? ' (cyclic)' : ''}${unit.wave !== undefined ? ` · wave ${unit.wave}` : ''}`,
  ];
  if (deps.length > 0) lines.push(`Depends on: ${deps.map((d) => d.label || d.id).join(', ')}`);
  return lines.join('<br/>');
}

function buildModuleTooltip(mod: AppNodeWire, model: AppGraphModel, migration: MigrationModel | null): string {
  const sc = typeof mod.attrs?.symbolCount === 'number' ? mod.attrs.symbolCount : 0;
  const lines = [`<b>${mod.name}</b>`, `Kind: ${mod.kind}`, `Symbols: ${sc}`];
  if (mod.attrs?.dir) lines.push(`Dir: ${mod.attrs.dir}`);
  if (migration) {
    const unitId = migration.moduleToUnit.get(mod.id);
    if (unitId) {
      const status = unitStatus(migration, unitId);
      lines.push(`Migration unit: ${migration.unitById.get(unitId)?.label ?? unitId} (${migrationStatusLabel(status)})`);
    }
  }
  return lines.join('<br/>');
}
