/**
 * AppGraph node detail — the relationship-centric L3 view.
 *
 * Replaces the old flat field-list + incoming/outgoing edge TABLES with
 * grouped, semantic chip sections: each AppEdgeKind that touches this node
 * becomes a labeled chip group ("Navigates to →", "Requires permission →",
 * "Uses capability →", "Depends on →", …), each chip a link to the related
 * node. A small trust meter + role tags surface the provenance/confidence
 * distinction (manifest vs lifted vs llm) and the Feature-role /
 * depends_on-suspect flags that the B-series fixes introduced. The cross-graph
 * CodeGraph drill-down and raw JSON stay, but raw JSON collapses by default.
 */

import { api } from '../api';
import { buildAppGraphModel, incoming, outgoing, owningModule, type AppGraphModel } from '../appgraph-model';
import {
  chip,
  chipLink,
  colorChip,
  colorChipLink,
  breadcrumb,
  el,
  errorBox,
  link,
  meter,
  mount,
  section,
  spinner,
} from '../render';
import {
  dependsOnFlag,
  edgeStyle,
  featureRoleTone,
  nodeColor,
  provenanceLabel,
  provenanceTrust,
  roleOf,
} from '../visual';
import type { AppEdgeWire, AppNodeWire } from '../../wire-types';

export async function renderAppNodeDetail(container: HTMLElement, id: string): Promise<void> {
  mount(container, spinner());
  try {
    const [{ graph }, detail] = await Promise.all([api.appGraph(), api.appNode(id)]);
    const model = buildAppGraphModel(graph);
    const node = model.byId.get(id) ?? detail.node;

    mount(container, nodeDetailFor(model, node, detail.drillDown));
  } catch (err) {
    mount(container, errorBox(err instanceof Error ? err.message : String(err)));
  }
}

function nodeDetailFor(
  model: AppGraphModel,
  node: AppNodeWire,
  drillDown: Array<{ id: string; name: string; kind: string; filePath: string }>
): HTMLElement {
  const owner = owningModule(model, node.id);
  const crumbs = [
    { label: 'AppGraph', href: '#/appgraph' },
    ...(owner ? [{ label: owner.name, href: `#/appgraph/modules/${encodeURIComponent(owner.id)}` }] : []),
    { label: node.name },
  ];

  return el('div', { class: 'detail' }, [
    breadcrumb(crumbs),
    header(model, node),
    el('div', { class: 'toolbar' }, [
      link('View in graph →', `#/appgraph/graph?focus=${encodeURIComponent(node.id)}`),
      owner
        ? link('Open module →', `#/appgraph/modules/${encodeURIComponent(owner.id)}`)
        : null,
    ]),
    relationshipSections(model, node),
    el('div', { class: 'section-title' }, ['Lifted from CodeGraph']),
    codeDrillDown(drillDown),
    el('div', { class: 'section-title' }, ['Raw JSON']),
    rawJsonToggle(node),
  ]);
}

function header(model: AppGraphModel, node: AppNodeWire): HTMLElement {
  const role = node.kind === 'Feature' ? roleOf(node) : node.subtype;
  const roleTone = node.kind === 'Feature' ? featureRoleTone(role) : null;
  return el('div', { class: 'detail-header' }, [
    colorChip(node.kind, nodeColor(node.kind)),
    el('h2', { class: 'detail-title' }, [node.name]),
    role ? chip(roleTone ? roleTone.label : role, roleTone?.tone) : null,
    el('div', { class: 'detail-trust' }, [
      meter(
        Math.max(provenanceTrust(node.provenance), node.confidence),
        `${provenanceLabel(node.provenance)} · conf ${(node.confidence * 100).toFixed(0)}%`
      ),
    ]),
  ]);
}

/** Renders every edge-kind section that touches this node, in semantic order.
 *  Outgoing first ("Navigates to"), then the incoming counterpart ("Reached
 *  from") where meaningful. depends_on carries a declared/lifted/suspect tag. */
function relationshipSections(model: AppGraphModel, node: AppNodeWire): HTMLElement {
  const out = (kind: string) => outgoing(model, node.id, kind);
  const inc = (kind: string) => incoming(model, node.id, kind);

  const groups: Array<[string, AppEdgeWire[], 'out' | 'in']> = [
    ['app_contains', out('app_contains'), 'out'],
    ['app_contains', inc('app_contains'), 'in'],
    ['navigates_to', out('navigates_to'), 'out'],
    ['navigates_to', inc('navigates_to'), 'in'],
    ['backed_by', out('backed_by'), 'out'],
    ['backed_by', inc('backed_by'), 'in'],
    ['requires_permission', out('requires_permission'), 'out'],
    ['requires_permission', inc('requires_permission'), 'in'],
    ['uses_capability', out('uses_capability'), 'out'],
    ['uses_capability', inc('uses_capability'), 'in'],
    ['exposes', out('exposes'), 'out'],
    ['exposes', inc('exposes'), 'in'],
    ['depends_on', out('depends_on'), 'out'],
    ['depends_on', inc('depends_on'), 'in'],
    ['maps_to', out('maps_to'), 'out'],
    ['maps_to', inc('maps_to'), 'in'],
  ];

  // Collapse the outgoing/incoming pair of one kind into a single section
  // when both are non-empty, with two labeled chip rows; a single-direction
  // pair gets a single row. Keeps the page compact instead of 16 near-empty
  // sections.
  const byKind = new Map<string, { out: AppEdgeWire[]; in: AppEdgeWire[] }>();
  for (const [kind, edges, dir] of groups) {
    let bucket = byKind.get(kind);
    if (!bucket) {
      bucket = { out: [], in: [] };
      byKind.set(kind, bucket);
    }
    if (dir === 'out') bucket.out.push(...edges);
    else bucket.in.push(...edges);
  }

  const order = [
    'app_contains',
    'navigates_to',
    'backed_by',
    'requires_permission',
    'uses_capability',
    'exposes',
    'depends_on',
    'maps_to',
  ];

  const sections: HTMLElement[] = [];
  for (const kind of order) {
    const bucket = byKind.get(kind);
    if (!bucket || (bucket.out.length === 0 && bucket.in.length === 0)) continue;
    const style = edgeStyle(kind);
    const total = bucket.out.length + bucket.in.length;
    sections.push(
      section(directionalLabel(kind, bucket), total, edgeChips(model, node, kind, bucket, style))
    );
  }

  if (sections.length === 0) {
    return el('div', { class: 'empty-state' }, ['No relationships recorded for this node.']);
  }
  return el('div', { class: 'rel-groups' }, sections);
}

function directionalLabel(
  kind: string,
  bucket: { out: AppEdgeWire[]; in: AppEdgeWire[] }
): string {
  const style = edgeStyle(kind);
  const hasOut = bucket.out.length > 0;
  const hasIn = bucket.in.length > 0;
  if (hasOut && hasIn) return `${style.label} (outgoing & incoming)`;
  if (hasIn) return incomingLabel(kind);
  return style.label;
}

/** The natural-language label for the incoming side of a kind, so "Navigates
 *  to" reads as "Reached from" instead of the cryptic "incoming navigates_to". */
function incomingLabel(kind: string): string {
  switch (kind) {
    case 'app_contains':
      return 'contained in';
    case 'navigates_to':
      return 'reached from';
    case 'backed_by':
      return 'backs';
    case 'requires_permission':
      return 'required by';
    case 'uses_capability':
      return 'used by';
    case 'exposes':
      return 'exposed by';
    case 'depends_on':
      return 'depended on by';
    case 'maps_to':
      return 'maps to';
    default:
      return edgeStyle(kind).label;
  }
}

function edgeChips(
  model: AppGraphModel,
  _node: AppNodeWire,
  kind: string,
  bucket: { out: AppEdgeWire[]; in: AppEdgeWire[] },
  style: { color: string; dash: string }
): HTMLElement {
  const rows: HTMLElement[] = [];
  const renderRow = (label: string, edges: AppEdgeWire[], reverse: boolean): void => {
    if (edges.length === 0) return;
    rows.push(
      el('div', { class: 'chip-row' }, [
        el('span', { class: 'chip-row-label', style: `--edge-color:${style.color}` }, [label]),
        el('div', { class: 'chip-list' }, edges.map((e) => edgeChip(model, e, kind, reverse))),
      ])
    );
  };
  if (bucket.out.length > 0) renderRow('→', bucket.out, false);
  if (bucket.in.length > 0) renderRow('←', bucket.in, true);
  return el('div', { class: 'edge-chips' }, rows);
}

function edgeChip(model: AppGraphModel, e: AppEdgeWire, kind: string, reverse: boolean): HTMLElement {
  const otherId = reverse ? e.from : e.to;
  const other = model.byId.get(otherId);
  if (!other) return chip('(missing)');
  const href = `#/appgraph/nodes/${encodeURIComponent(other.id)}`;
  const name = other.name;
  const detail = chipDetail(other, e, kind);
  const flag = kind === 'depends_on' ? dependsOnFlag(e) : null;
  return el('span', { class: 'chip-cluster' }, [
    colorChipLink(name, href, nodeColor(other.kind)),
    detail ? chip(detail.text, detail.tone) : null,
    flag ? chip(flag.label, flag.tone) : null,
  ]);
}

/** Extra inline detail for a chip where useful: a Capability's HarmonyOS
 *  target, a Feature's size/cohesion, a DataModel's framework, a
 *  depends_on edge's weight. Returns null when nothing noteworthy. */
function chipDetail(
  other: AppNodeWire,
  e: AppEdgeWire,
  kind: string
): { text: string; tone?: string } | null {
  const a = other.attrs ?? {};
  switch (other.kind) {
    case 'Capability':
      return typeof a.harmonyModule === 'string' && a.harmonyModule
        ? { text: `→ ${a.harmonyModule}`, tone: 'ok' }
        : null;
    case 'Feature':
      if (typeof a.size === 'number') return { text: `${a.size} files` };
      return null;
    case 'DataModel':
      if (typeof a.framework === 'string') return { text: a.framework, tone: 'info' };
      return null;
    case 'ArchModule':
      if (typeof a.symbolCount === 'number') return { text: `${a.symbolCount} symbols` };
      return null;
    case 'Permission':
      return null;
    default:
      break;
  }
  // Edge-level attrs (depends_on weight / app_contains fileCount).
  if (kind === 'depends_on' && typeof e.attrs?.weight === 'number') {
    return { text: `×${e.attrs.weight}`, tone: 'info' };
  }
  if (kind === 'app_contains' && typeof e.attrs?.fileCount === 'number') {
    return { text: `${e.attrs.fileCount} files` };
  }
  return null;
}

function codeDrillDown(
  drillDown: Array<{ id: string; name: string; kind: string; filePath: string }>
): HTMLElement {
  if (drillDown.length === 0) {
    return el('div', { class: 'empty-state' }, ['No platformRef, or no matching CodeGraph symbol']);
  }
  return el(
    'ul',
    { class: 'drill-list' },
    drillDown.map((d) =>
      el('li', { class: 'drill-item' }, [
        colorChip(d.kind, '#5b8dff'),
        link(d.name, `#/codegraph/nodes/${encodeURIComponent(d.id)}`),
        el('span', { class: 'result-path' }, [d.filePath]),
      ])
    )
  );
}

function rawJsonToggle(node: AppNodeWire): HTMLElement {
  const pre = el('pre', { class: 'json-block', style: 'display:none' }, [JSON.stringify(node, null, 2)]);
  return el('div', {}, [
    el('button', { onclick: () => void toggle(pre) }, ['Show']),
    pre,
  ]);
}

function toggle(el_: HTMLElement): void {
  el_.style.display = el_.style.display === 'none' ? 'block' : 'none';
}
