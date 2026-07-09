/**
 * AppGraph module drill-down (L2) — answers "I can't drill into each module".
 *
 * For an ArchModule node: shows everything INSIDE it (the children reachable
 * via app_contains, grouped by kind as clickable chip grids), plus its
 * depends_on graph in both directions with the declared/lifted/suspect
 * distinction the B-series fixes introduced (declared = solid, lifted =
 * dashed, suspect='reverse-of-declared' = red). The module's feature
 * communities show their role (subdivision/aligned/cross-module) and size.
 */

import { api } from '../api';
import { buildAppGraphModel, incoming, outgoing, roleOf, type AppGraphModel } from '../appgraph-model';
import {
  chip,
  colorChip,
  colorChipLink,
  breadcrumb,
  el,
  empty,
  errorBox,
  link,
  meter,
  mount,
  section,
  spinner,
} from '../render';
import { dependsOnFlag, edgeStyle, featureRoleTone, nodeColor } from '../visual';
import type { AppEdgeWire, AppNodeWire } from '../../wire-types';

export async function renderAppGraphModuleView(container: HTMLElement, id: string): Promise<void> {
  mount(container, spinner());
  try {
    const { graph } = await api.appGraph();
    const model = buildAppGraphModel(graph);
    const node = model.byId.get(id);
    if (!node || node.kind !== 'ArchModule') {
      mount(container, errorBox(`No ArchModule with id "${id}".`));
      return;
    }
    mount(container, moduleView(model, node));
  } catch (err) {
    mount(container, errorBox(err instanceof Error ? err.message : String(err)));
  }
}

function moduleView(model: AppGraphModel, node: AppNodeWire): HTMLElement {
  const children = model.childrenOf.get(node.id) ?? [];
  const dir = typeof node.attrs?.dir === 'string' ? node.attrs.dir : undefined;
  const symbolCount = typeof node.attrs?.symbolCount === 'number' ? node.attrs.symbolCount : undefined;

  return el('div', { class: 'detail' }, [
    breadcrumb([
      { label: 'AppGraph', href: '#/appgraph' },
      { label: node.name },
    ]),
    el('div', { class: 'detail-header' }, [
      colorChip(node.kind, nodeColor(node.kind)),
      el('h2', { class: 'detail-title' }, [node.name]),
      symbolCount !== undefined ? chip(`${symbolCount} symbols`, 'info') : null,
      el('div', { class: 'detail-trust' }, [meter(1, 'declared module')]),
    ]),
    el('div', { class: 'toolbar' }, [
      link('View in graph →', `#/appgraph/graph?focus=${encodeURIComponent(node.id)}`),
      link('All modules →', '#/appgraph'),
    ]),
    dir
      ? fieldLine('Module dir', dir)
      : null,
    insideModule(model, children),
    dependencies(model, node),
  ]);
}

function fieldLine(label: string, value: string): HTMLElement {
  return el('div', { class: 'field-row' }, [
    el('div', { class: 'field-label' }, [label]),
    el('div', { class: 'field-value' }, [value]),
  ]);
}

/** Children of the module grouped by kind — the "what's inside" view. Each
 *  kind is a chip grid; chips link to that child's node detail. */
function insideModule(model: AppGraphModel, children: AppNodeWire[]): HTMLElement {
  if (children.length === 0) {
    return el('div', { class: 'empty-state' }, ['No nodes assigned to this module.']);
  }
  const byKind = new Map<string, AppNodeWire[]>();
  for (const c of children) {
    const arr = byKind.get(c.kind) ?? [];
    arr.push(c);
    byKind.set(c.kind, arr);
  }

  const kindOrder = ['Feature', 'Screen', 'BackgroundComponent', 'DataModel', 'Capability', 'Permission', 'Resource', 'AppEntry'];
  const present = kindOrder.filter((k) => byKind.has(k));

  return section('Inside this module', children.length, ...present.map((k) => childGrid(model, k, byKind.get(k) ?? [])));
}

function childGrid(model: AppGraphModel, kind: string, items: AppNodeWire[]): HTMLElement {
  return el('div', { class: 'chip-group' }, [
    el('div', { class: 'chip-group-title', style: `--edge-color:${nodeColor(kind)}` }, [kind]),
    el('div', { class: 'chip-list' }, items.map((n) => childChip(model, n))),
  ]);
}

function childChip(model: AppGraphModel, n: AppNodeWire): HTMLElement {
  const href = `#/appgraph/nodes/${encodeURIComponent(n.id)}`;
  const a = n.attrs ?? {};
  let extra: { text: string; tone?: string } | null = null;
  if (n.kind === 'Feature') {
    const role = roleOf(n);
    const tone = featureRoleTone(role);
    extra = { text: `${tone.label}`, tone: tone.tone };
    if (typeof a.size === 'number') {
      return el('span', { class: 'chip-cluster' }, [
        colorChipLink(n.name, href, nodeColor(n.kind)),
        chip(extra.text, extra.tone),
        chip(`${a.size} files`, 'info'),
      ]);
    }
  } else if (n.kind === 'Capability' && typeof a.harmonyModule === 'string' && a.harmonyModule) {
    extra = { text: `→ ${a.harmonyModule}`, tone: 'ok' };
  } else if (n.kind === 'Screen') {
    const navCount = outgoing(model, n.id, 'navigates_to').length;
    if (navCount > 0) extra = { text: `${navCount} nav targets`, tone: 'info' };
  } else if (n.kind === 'DataModel' && typeof a.framework === 'string') {
    extra = { text: a.framework, tone: 'info' };
  }
  return el('span', { class: 'chip-cluster' }, [
    colorChipLink(n.name, href, nodeColor(n.kind)),
    extra ? chip(extra.text, extra.tone) : null,
  ]);
}

/** The module's depends_on graph, both directions, with the
 *  declared/lifted/suspect tag on each chip. */
function dependencies(model: AppGraphModel, node: AppNodeWire): HTMLElement {
  const outs = outgoing(model, node.id, 'depends_on');
  const ins = incoming(model, node.id, 'depends_on');
  if (outs.length === 0 && ins.length === 0) {
    return section('Module dependencies', 0, empty('No module dependencies recorded.'));
  }
  const style = edgeStyle('depends_on');
  return section(
    'Module dependencies',
    outs.length + ins.length,
    depRows(model, outs, '→ depends on', false, style.color),
    depRows(model, ins, '← depended on by', true, style.color)
  );
}

function depRows(
  model: AppGraphModel,
  edges: AppEdgeWire[],
  label: string,
  reverse: boolean,
  color: string
): HTMLElement {
  if (edges.length === 0) return el('div', {});
  return el('div', { class: 'chip-row' }, [
    el('span', { class: 'chip-row-label', style: `--edge-color:${color}` }, [label]),
    el('div', { class: 'chip-list' }, edges.map((e) => depChip(model, e, reverse))),
  ]);
}

function depChip(model: AppGraphModel, e: AppEdgeWire, reverse: boolean): HTMLElement {
  const otherId = reverse ? e.from : e.to;
  const other = model.byId.get(otherId);
  if (!other) return chip('(missing)');
  const href = `#/appgraph/modules/${encodeURIComponent(other.id)}`;
  const flag = dependsOnFlag(e);
  const weight = typeof e.attrs?.weight === 'number' ? `×${e.attrs.weight}` : null;
  return el('span', { class: 'chip-cluster' }, [
    colorChipLink(other.name, href, nodeColor(other.kind)),
    flag ? chip(flag.label, flag.tone) : null,
    weight ? chip(weight, 'info') : null,
  ]);
}
