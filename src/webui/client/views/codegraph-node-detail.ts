import { api, EdgeWithOther } from '../api';
import { badge, badgeList, el, errorBox, jsonBlock, link, mount, spinner, table } from '../render';
import type { Node } from '../../../types';

/** Renders every field of one CodeGraph node plus its incoming/outgoing
 *  edges — the "every field, every relationship" requirement for this layer.
 *  Used as the main panel by codegraph-nodes-view.ts. */
export async function renderNodeDetail(container: HTMLElement, id: string): Promise<void> {
  mount(container, spinner());
  try {
    const { node, incoming, outgoing } = await api.getNode(id);
    mount(
      container,
      el('div', {}, [
        el('div', { class: 'toolbar' }, [
          badge(node.kind, node.kind),
          el('h2', { style: 'margin:0' }, [node.name]),
        ]),
        fieldsFor(node),
        el('div', { class: 'toolbar' }, [
          link('View in graph →', `#/codegraph/graph?start=${encodeURIComponent(node.id)}&mode=impact&depth=2`),
          el('button', { onclick: () => void showCode(container, node) }, ['View source']),
        ]),
        el('div', { class: 'section-title' }, [`Incoming edges (${incoming.length})`]),
        edgeTable(incoming, 'source'),
        el('div', { class: 'section-title' }, [`Outgoing edges (${outgoing.length})`]),
        edgeTable(outgoing, 'target'),
        el('div', { class: 'section-title' }, ['Raw JSON']),
        jsonBlock(node),
      ])
    );
  } catch (err) {
    mount(container, errorBox(err instanceof Error ? err.message : String(err)));
  }
}

function fieldsFor(node: Node): HTMLElement {
  const row = (label: string, value: unknown): HTMLElement =>
    el('div', { class: 'field-row' }, [
      el('div', { class: 'field-label' }, [label]),
      el('div', { class: 'field-value' }, [formatValue(value)]),
    ]);

  return el('div', { class: 'field-list' }, [
    row('id', node.id),
    row('kind', node.kind),
    row('name', node.name),
    row('qualifiedName', node.qualifiedName),
    row('filePath', link(node.filePath, `#/codegraph/files?q=${encodeURIComponent(node.filePath)}`)),
    row('language', node.language),
    row('lines', `${node.startLine}–${node.endLine}`),
    row('columns', `${node.startColumn}–${node.endColumn}`),
    row('visibility', node.visibility),
    row('isExported', node.isExported),
    row('isAsync', node.isAsync),
    row('isStatic', node.isStatic),
    row('isAbstract', node.isAbstract),
    row('decorators', node.decorators && node.decorators.length > 0 ? badgeList(node.decorators) : undefined),
    row('typeParameters', node.typeParameters && node.typeParameters.length > 0 ? badgeList(node.typeParameters) : undefined),
    row('returnType', node.returnType),
    row('signature', node.signature),
    row('docstring', node.docstring),
    row('updatedAt', new Date(node.updatedAt).toLocaleString()),
  ]);
}

function formatValue(value: unknown): string | HTMLElement {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof HTMLElement) return value;
  return String(value);
}

function edgeTable(edges: EdgeWithOther[], otherSide: 'source' | 'target'): HTMLElement {
  if (edges.length === 0) return el('div', { class: 'empty-state' }, ['None']);
  return table(
    ['kind', otherSide === 'source' ? 'from' : 'to', 'provenance', 'location'],
    edges.map(({ edge, other }) => [
      badge(edge.kind),
      other ? link(`${other.name} (${other.kind})`, `#/codegraph/nodes/${encodeURIComponent(other.id)}`) : '(deleted)',
      edge.provenance ?? '—',
      edge.line !== undefined ? `${edge.line}:${edge.column ?? 0}` : '—',
    ])
  );
}

async function showCode(container: HTMLElement, node: Node): Promise<void> {
  const target = container.querySelector('.source-block');
  if (target) {
    target.remove();
    return;
  }
  const block = el('pre', { class: 'json-block source-block' }, ['Loading…']);
  container.appendChild(block);
  try {
    const { code } = await api.getNodeCode(node.id);
    block.textContent = code ?? '(no source available)';
  } catch (err) {
    block.textContent = err instanceof Error ? err.message : String(err);
  }
}
