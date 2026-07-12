/**
 * Floating detail panel — shows node details based on the current zoom level.
 * Positioned top-left of the graph canvas area (absolute).
 *
 * Level 0: migration unit details (members, dependencies, status, ledger)
 * Level 1: module details (children by kind, dependencies, role, symbol count)
 * Level 2: code symbol details (kind, file, line, callers, callees)
 */

import type { MigrationUnitWire, AppNodeWire, LedgerStatusWire, LedgerEntryWire } from '../wire-types';
import type { MigrationModel } from './migration-model';
import type { AppGraphModel } from './appgraph-model';
import { unitStatus, unitModules, unitDependencies, unitDependents } from './migration-model';
import { outgoing, incoming, owningModule } from './appgraph-model';
import { migrationStatusLabel, migrationStatusColor, migrationStatusTone, dependsOnFlag, provenanceLabel, provenanceTrust } from './visual';
import { el, mount, chip, colorChip, section, badge } from './render';
import type { Node as CgNode } from '../../types';

type Level = 0 | 1 | 2;

interface DetailState {
  migrationModel: MigrationModel | null;
  appModel: AppGraphModel | null;
  focusedModuleId: string | null;
  level2Cache: Map<string, { nodes: CgNode[]; edges: Array<{ source: string; target: string; kind: string }> }>;
}

export function renderDetailPanel(
  host: HTMLElement,
  level: Level,
  nodeId: string,
  data: unknown,
  state: DetailState,
): void {
  host.innerHTML = '';

  const head = el('div', { class: 'detail-head' }, [
    el('span', {}, ['Node Details']),
    el('button', {
      class: 'detail-close',
      onclick: () => host.classList.add('hidden'),
    }, ['×']),
  ]);

  const body = el('div', { class: 'detail-body scrollbar-thin' }, []);

  if (level === 0) {
    renderUnitDetail(body, data as MigrationUnitWire, state);
  } else if (level === 1) {
    renderModuleDetail(body, data as AppNodeWire, state);
  } else if (level === 2) {
    renderSymbolDetail(body, data as CgNode, state);
  } else {
    body.appendChild(el('div', { class: 'empty' }, ['No data']));
  }

  host.append(head, body);
}

function renderUnitDetail(body: HTMLElement, unit: MigrationUnitWire | undefined, state: DetailState): void {
  if (!unit || !state.migrationModel) {
    body.appendChild(el('span', { class: 'text-zinc-500' }, ['Select a migration unit to see details']));
    return;
  }

  const model = state.migrationModel;
  const status = unitStatus(model, unit.id);
  const mods = unitModules(model, unit.id);
  const deps = unitDependencies(model, unit.id);
  const dependents = unitDependents(model, unit.id);

  body.append(
    el('div', { class: 'name' }, [unit.label || unit.id]),
    el('div', { class: 'row mt-1' }, [
      el('span', { class: 'k' }, ['Status: ']),
      chip(migrationStatusLabel(status), migrationStatusTone(status)),
    ]),
    el('div', { class: 'row' }, [
      el('span', { class: 'k' }, ['Order: ']),
      `#${unit.order}${unit.cyclic ? ' (cyclic)' : ''}`,
    ]),
    el('div', { class: 'row' }, [
      el('span', { class: 'k' }, ['Wave: ']),
      unit.wave !== undefined ? String(unit.wave) : '—',
    ]),
    el('div', { class: 'row' }, [
      el('span', { class: 'k' }, ['Necessity: ']),
      unit.necessity === 'dev-only' ? 'Dev-only' : 'Production',
    ]),
    el('hr', { class: 'border-detail-border my-2' }, []),
    el('div', { class: 'row' }, [
      el('span', { class: 'k' }, [`Member modules (${mods.length}):`]),
    ]),
    ...mods.map((m) =>
      el('div', { class: 'ml-2 text-xs' }, [
        colorChip(m.name, migrationStatusColor(status)),
        typeof m.attrs?.symbolCount === 'number' ? ` (${m.attrs.symbolCount} symbols)` : '',
      ]),
    ),
  );

  if (deps.length > 0) {
    body.append(
      el('hr', { class: 'border-detail-border my-2' }, []),
      el('div', { class: 'row' }, [el('span', { class: 'k' }, [`Depends on (${deps.length}):`])]),
      ...deps.map((d) =>
        el('div', { class: 'ml-2 text-xs' }, [
          colorChip(d.label || d.id, migrationStatusColor(unitStatus(model, d.id))),
        ]),
      ),
    );
  }

  if (dependents.length > 0) {
    body.append(
      el('hr', { class: 'border-detail-border my-2' }, []),
      el('div', { class: 'row' }, [el('span', { class: 'k' }, [`Depended on by (${dependents.length}):`])]),
      ...dependents.map((d) =>
        el('div', { class: 'ml-2 text-xs' }, [
          colorChip(d.label || d.id, migrationStatusColor(unitStatus(model, d.id))),
        ]),
      ),
    );
  }
}

function renderModuleDetail(body: HTMLElement, mod: AppNodeWire | undefined, state: DetailState): void {
  if (!mod || !state.appModel) {
    body.appendChild(el('span', { class: 'text-zinc-500' }, ['Select a module to see details']));
    return;
  }

  const model = state.appModel;
  const migration = state.migrationModel;
  const sc = typeof mod.attrs?.symbolCount === 'number' ? mod.attrs.symbolCount : 0;
  const outs = outgoing(model, mod.id, 'depends_on');
  const ins = incoming(model, mod.id, 'depends_on');

  body.append(
    el('div', { class: 'name' }, [mod.name]),
    el('div', { class: 'row mt-1' }, [
      el('span', { class: 'k' }, ['Kind: ']),
      mod.kind,
    ]),
    el('div', { class: 'row' }, [
      el('span', { class: 'k' }, ['Symbols: ']),
      String(sc),
    ]),
  );

  if (mod.attrs?.dir) {
    body.append(el('div', { class: 'row' }, [
      el('span', { class: 'k' }, ['Dir: ']),
      el('span', { class: 'text-xs break-all' }, [mod.attrs.dir as string]),
    ]));
  }

  if (mod.attrs?.role) {
    body.append(el('div', { class: 'row' }, [
      el('span', { class: 'k' }, ['Role: ']),
      mod.attrs.role as string,
    ]));
  }

  if (migration) {
    const unitId = migration.moduleToUnit.get(mod.id);
    if (unitId) {
      const unit = migration.unitById.get(unitId);
      const status = unitStatus(migration, unitId);
      body.append(
        el('hr', { class: 'border-detail-border my-2' }, []),
        el('div', { class: 'row' }, [
          el('span', { class: 'k' }, ['Migration unit: ']),
          colorChip(unit?.label || unitId, migrationStatusColor(status)),
        ]),
        el('div', { class: 'row' }, [
          el('span', { class: 'k' }, ['Status: ']),
          chip(migrationStatusLabel(status), migrationStatusTone(status)),
        ]),
      );
    }
  }

  const children = model.childrenOf.get(mod.id) ?? [];
  if (children.length > 0) {
    const byKind = new Map<string, AppNodeWire[]>();
    for (const c of children) {
      const arr = byKind.get(c.kind) ?? [];
      arr.push(c);
      byKind.set(c.kind, arr);
    }
    body.append(
      el('hr', { class: 'border-detail-border my-2' }, []),
      el('div', { class: 'row' }, [el('span', { class: 'k' }, [`Contains (${children.length}):`])]),
    );
    for (const [kind, nodes] of byKind) {
      body.append(el('div', { class: 'ml-2 text-xs' }, [
        el('span', { class: 'text-zinc-400' }, [`${kind} (${nodes.length}): `]),
        ...nodes.map((n, i) => i < nodes.length - 1 ? `${n.name}, ` : n.name),
      ]));
    }
  }

  if (outs.length > 0) {
    body.append(
      el('hr', { class: 'border-detail-border my-2' }, []),
      el('div', { class: 'row' }, [el('span', { class: 'k' }, [`Depends on (${outs.length}):`])]),
      ...outs.map((e) => {
        const other = model.byId.get(e.to);
        const flag = dependsOnFlag(e);
        return el('div', { class: 'ml-2 text-xs' }, [
          other ? colorChip(other.name, '#e0954f') : e.to,
          flag ? ` (${flag.label})` : '',
        ]);
      }),
    );
  }

  if (ins.length > 0) {
    body.append(
      el('hr', { class: 'border-detail-border my-2' }, []),
      el('div', { class: 'row' }, [el('span', { class: 'k' }, [`Depended on by (${ins.length}):`])]),
      ...ins.map((e) => {
        const other = model.byId.get(e.from);
        const flag = dependsOnFlag(e);
        return el('div', { class: 'ml-2 text-xs' }, [
          other ? colorChip(other.name, '#e0954f') : e.from,
          flag ? ` (${flag.label})` : '',
        ]);
      }),
    );
  }
}

function renderSymbolDetail(body: HTMLElement, node: CgNode | undefined, state: DetailState): void {
  if (!node) {
    body.appendChild(el('span', { class: 'text-zinc-500' }, ['Select a symbol to see details']));
    return;
  }

  body.append(
    el('div', { class: 'name' }, [node.name]),
    el('div', { class: 'row mt-1' }, [
      el('span', { class: 'k' }, ['Kind: ']),
      badge(node.kind),
    ]),
    el('div', { class: 'row' }, [
      el('span', { class: 'k' }, ['File: ']),
      el('span', { class: 'text-xs break-all' }, [`${node.filePath}:${node.startLine}`]),
    ]),
  );

  if (node.qualifiedName && node.qualifiedName !== node.name) {
    body.append(el('div', { class: 'row' }, [
      el('span', { class: 'k' }, ['Qualified: ']),
      el('span', { class: 'text-xs break-all' }, [node.qualifiedName]),
    ]));
  }

  if (node.language) {
    body.append(el('div', { class: 'row' }, [
      el('span', { class: 'k' }, ['Language: ']),
      node.language,
    ]));
  }

  if (node.signature) {
    body.append(
      el('hr', { class: 'border-detail-border my-2' }, []),
      el('div', { class: 'row' }, [el('span', { class: 'k' }, ['Signature: '])]),
      el('pre', { class: 'text-xs whitespace-pre-wrap' }, [node.signature]),
    );
  }
}
