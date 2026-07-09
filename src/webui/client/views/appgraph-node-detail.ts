import { api, AppEdgeWithOther } from '../api';
import { badge, el, errorBox, jsonBlock, link, mount, spinner, table } from '../render';
import type { AppNodeWire } from '../../wire-types';

/** Renders every field of one AppNode plus its incoming/outgoing edges and,
 *  when available, the CodeGraph symbol(s) it was lifted from. Used as the
 *  main panel by appgraph-view.ts. */
export async function renderAppNodeDetail(container: HTMLElement, id: string): Promise<void> {
  mount(container, spinner());
  try {
    const { node, incoming, outgoing, drillDown } = await api.appNode(id);
    mount(
      container,
      el('div', {}, [
        el('div', { class: 'toolbar' }, [badge(node.kind, node.kind), el('h2', { style: 'margin:0' }, [node.name])]),
        fieldsFor(node),
        el('div', { class: 'toolbar' }, [link('View in graph →', `#/appgraph/graph?focus=${encodeURIComponent(node.id)}`)]),
        el('div', { class: 'section-title' }, [`Incoming edges (${incoming.length})`]),
        edgeTable(incoming),
        el('div', { class: 'section-title' }, [`Outgoing edges (${outgoing.length})`]),
        edgeTable(outgoing),
        el('div', { class: 'section-title' }, [`Lifted from CodeGraph (${drillDown.length})`]),
        drillDown.length === 0
          ? el('div', { class: 'empty-state' }, ['No platformRef, or no matching CodeGraph symbol'])
          : table(
              ['symbol', 'kind', 'file'],
              drillDown.map((d) => [link(d.name, `#/codegraph/nodes/${encodeURIComponent(d.id)}`), d.kind, d.filePath])
            ),
        el('div', { class: 'section-title' }, ['Raw JSON']),
        jsonBlock(node),
      ])
    );
  } catch (err) {
    mount(container, errorBox(err instanceof Error ? err.message : String(err)));
  }
}

function fieldsFor(node: AppNodeWire): HTMLElement {
  const row = (label: string, value: unknown): HTMLElement =>
    el('div', { class: 'field-row' }, [
      el('div', { class: 'field-label' }, [label]),
      el('div', { class: 'field-value' }, [formatValue(value)]),
    ]);

  return el('div', { class: 'field-list' }, [
    row('id', node.id),
    row('kind', node.kind),
    row('matchKey', node.matchKey),
    row('name', node.name),
    row('platform', node.platform),
    row('subtype', node.subtype),
    row('platformRef.file', node.platformRef?.file),
    row('platformRef.symbol', node.platformRef?.symbol),
    row('provenance', node.provenance),
    row('fidelity', node.fidelity),
    row('confidence', node.confidence),
    row('attrs', node.attrs && Object.keys(node.attrs).length > 0 ? jsonBlock(node.attrs) : undefined),
  ]);
}

function formatValue(value: unknown): string | HTMLElement {
  if (value === undefined || value === null || value === '') return '—';
  if (value instanceof HTMLElement) return value;
  return String(value);
}

function edgeTable(edges: AppEdgeWithOther[]): HTMLElement {
  if (edges.length === 0) return el('div', { class: 'empty-state' }, ['None']);
  return table(
    ['kind', 'other node', 'provenance', 'confidence'],
    edges.map(({ edge, other }) => [
      badge(edge.kind),
      other ? link(`${other.name} (${other.kind})`, `#/appgraph/nodes/${encodeURIComponent(other.id)}`) : '(missing)',
      edge.provenance,
      String(edge.confidence),
    ])
  );
}
