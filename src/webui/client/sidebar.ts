/**
 * Left sidebar — dark-themed panel with project info, stats, search,
 * legend, filters, and tool buttons.
 *
 * Layout matches the reference page's sidebar: dark background, stat
 * grid, toggleable legend items, search box, and tool buttons.
 */

import type { MigrationModel } from './migration-model';
import type { AppGraphModel } from './appgraph-model';
import type { StatusResponse } from './api';
import type { LedgerStatusWire } from '../wire-types';
import { MIGRATION_STATUS_STYLES, migrationStatusLabel, migrationStatusColor } from './visual';
import { CG_NODE_STYLES, APP_NODE_STYLES, PALETTE } from './unified-colors';
import { el, mount } from './render';

type Level = 0 | 1 | 2;

export interface SidebarCallbacks {
  onFit: () => void;
  onTogglePhysics: () => void;
  onLevelSelect: (level: number) => void;
  onSearch: (text: string) => void;
  onToggleCategory: (cat: string) => void;
}

interface SidebarState {
  status: StatusResponse;
  migrationModel: MigrationModel | null;
  appModel: AppGraphModel | null;
  currentLevel: Level;
  physicsEnabled: boolean;
  disabledCategories: Set<string>;
  searchText: string;
}

export function renderSidebar(host: HTMLElement, state: SidebarState, callbacks: SidebarCallbacks): void {
  host.innerHTML = '';

  const projectName = state.status.projectRoot.split('/').pop() || state.status.projectRoot;

  host.append(
    el('h1', {}, [projectName]),
    el('div', { class: 'sub' }, [state.status.projectRoot]),
  );

  host.appendChild(buildStats(state));
  host.appendChild(buildSearchBox(state, callbacks));
  host.appendChild(buildTools(state, callbacks));
  host.appendChild(buildLegend(state, callbacks));
}

function buildStats(state: SidebarState): HTMLElement {
  const stats: Array<{ num: string; lbl: string; warn?: boolean; good?: boolean }> = [];

  if (state.migrationModel) {
    const m = state.migrationModel;
    stats.push(
      { num: String(m.totalUnits), lbl: 'Units' },
      { num: String(m.units.filter((u) => u.cyclic).length), lbl: 'Cyclic', warn: true },
      { num: String(m.statusCounts.verified), lbl: 'Verified', good: true },
      { num: String(m.statusCounts.blocked), lbl: 'Blocked', warn: true },
    );
  }

  if (state.appModel) {
    const a = state.appModel;
    stats.push(
      { num: String(a.modules.length), lbl: 'Modules' },
      { num: String(a.screens.length), lbl: 'Screens' },
      { num: String(a.capabilities.length), lbl: 'Capabilities' },
      { num: String(a.graph.edges.length), lbl: 'Edges' },
    );
  }

  if (state.status.codegraph.indexed && state.status.codegraph.stats) {
    stats.push({ num: String(state.status.codegraph.stats.nodeCount ?? 0), lbl: 'Symbols' });
  }

  if (stats.length === 0) {
    stats.push({ num: '—', lbl: 'No data' });
  }

  const grid = el('div', { class: 'stat-grid' }, []);
  for (const s of stats) {
    const cls = s.warn ? 'stat-box warn' : s.good ? 'stat-box good' : 'stat-box';
    grid.appendChild(el('div', { class: cls }, [
      el('div', { class: 'num' }, [s.num]),
      el('div', { class: 'lbl' }, [s.lbl]),
    ]));
  }
  return el('div', {}, [
    el('h2', {}, ['Overview']),
    grid,
  ]);
}

function buildSearchBox(state: SidebarState, callbacks: SidebarCallbacks): HTMLElement {
  const input = el('input', {
    class: 'search-input',
    type: 'text',
    placeholder: 'Search nodes…',
    value: state.searchText,
  }, []) as HTMLInputElement;
  input.addEventListener('input', () => callbacks.onSearch(input.value));

  return el('div', {}, [
    el('h2', {}, ['Search']),
    input,
  ]);
}

function buildTools(state: SidebarState, callbacks: SidebarCallbacks): HTMLElement {
  const fitBtn = el('span', {
    class: 'tool-btn',
    onclick: () => callbacks.onFit(),
  }, ['Fit canvas']);
  fitBtn.addEventListener('click', () => callbacks.onFit());

  const physicsBtn = el('span', {
    class: `tool-btn ${state.physicsEnabled ? 'active' : ''}`,
    onclick: () => callbacks.onTogglePhysics(),
  }, [`Physics: ${state.physicsEnabled ? 'On' : 'Off'}`]);

  const levelBtns: HTMLElement[] = [];
  const levels: Array<{ n: number; label: string; available: boolean }> = [
    { n: 0, label: 'Units', available: state.migrationModel !== null },
    { n: 1, label: 'Modules', available: state.appModel !== null },
    { n: 2, label: 'Code', available: state.status.codegraph.indexed },
  ];
  for (const lvl of levels) {
    if (!lvl.available) continue;
    const btn = el('span', {
      class: `tool-btn ${state.currentLevel === lvl.n ? 'active' : ''}`,
      onclick: () => callbacks.onLevelSelect(lvl.n),
    }, [lvl.label]);
    levelBtns.push(btn);
  }

  return el('div', {}, [
    el('h2', {}, ['View']),
    fitBtn,
    physicsBtn,
    el('div', { class: 'mt-1' }, levelBtns),
  ]);
}

function buildLegend(state: SidebarState, callbacks: SidebarCallbacks): HTMLElement {
  const container = el('div', {}, [el('h2', {}, ['Legend'])]);

  if (state.currentLevel === 0 && state.migrationModel) {
    const statuses: LedgerStatusWire[] = ['pending', 'in-progress', 'migrated', 'verified', 'blocked'];
    for (const s of statuses) {
      const count = state.migrationModel.statusCounts[s] ?? 0;
      if (count === 0 && s !== 'pending') continue;
      const item = el('div', {
        class: `legend-item ${state.disabledCategories.has(s) ? 'disabled' : ''}`,
        onclick: () => callbacks.onToggleCategory(s),
      }, [
        el('span', { class: 'swatch', style: `background:${migrationStatusColor(s)}` }, []),
        `${migrationStatusLabel(s)} (${count})`,
      ]);
      container.appendChild(item);
    }
  } else if (state.currentLevel === 1 && state.appModel) {
    const migration = state.migrationModel;
    if (migration) {
      const unitCount = migration.units.length;
      for (let i = 0; i < Math.min(unitCount, PALETTE.length); i++) {
        const unit = migration.units[i];
        if (!unit) continue;
        const color = PALETTE[i % PALETTE.length];
        const item = el('div', {
          class: `legend-item ${state.disabledCategories.has(unit.id) ? 'disabled' : ''}`,
          onclick: () => callbacks.onToggleCategory(unit.id),
        }, [
          el('span', { class: 'swatch', style: `background:${color}` }, []),
          `${unit.label || unit.id} (${unit.moduleIds.length})`,
        ]);
        container.appendChild(item);
      }
    } else {
      for (const [kind, style] of Object.entries(APP_NODE_STYLES)) {
        const count = state.appModel.nodesByKind.get(kind)?.length ?? 0;
        if (count === 0) continue;
        const item = el('div', {
          class: `legend-item ${state.disabledCategories.has(kind) ? 'disabled' : ''}`,
          onclick: () => callbacks.onToggleCategory(kind),
        }, [
          el('span', { class: 'swatch', style: `background:${style.color}` }, []),
          `${style.label} (${count})`,
        ]);
        container.appendChild(item);
      }
    }
  } else if (state.currentLevel === 2) {
    for (const [kind, style] of Object.entries(CG_NODE_STYLES)) {
      const item = el('div', {
        class: `legend-item ${state.disabledCategories.has(kind) ? 'disabled' : ''}`,
        onclick: () => callbacks.onToggleCategory(kind),
      }, [
        el('span', { class: 'swatch', style: `background:${style.color}` }, []),
        style.label,
      ]);
      container.appendChild(item);
    }
  }

  return container;
}
