import { api } from '../api';
import { badge, el, empty, errorBox, link, mount, spinner, table } from '../render';
import { renderAppNodeDetail } from './appgraph-node-detail';
import type { AppGraphWire } from '../../wire-types';

export async function renderAppGraphView(
  container: HTMLElement,
  params: { id?: string },
  query: URLSearchParams
): Promise<void> {
  const q = (query.get('q') ?? '').toLowerCase();
  const kind = query.get('kind') ?? '';
  const platform = query.get('platform') ?? '';

  const layout = el('div', { class: 'view-layout' }, [
    el('div', { class: 'view-sidebar' }, [spinner()]),
    el('div', { class: 'view-main' }, [params.id ? spinner() : empty('Select a node from the list')]),
  ]);
  mount(container, layout);

  const sidebar = layout.children[0] as HTMLElement;
  const main = layout.children[1] as HTMLElement;

  if (params.id) {
    void renderAppNodeDetail(main, params.id);
  } else {
    void renderOverviewMain(main);
  }

  try {
    const { graph } = await api.appGraph();
    const kinds = [...new Set(graph.nodes.map((n) => n.kind))].sort();
    const platforms = [...new Set(graph.nodes.map((n) => n.platform))].sort();

    const filtered = graph.nodes
      .filter((n) => (kind ? n.kind === kind : true))
      .filter((n) => (platform ? n.platform === platform : true))
      .filter((n) => (q ? n.name.toLowerCase().includes(q) || n.matchKey.toLowerCase().includes(q) : true))
      .sort((a, b) => a.name.localeCompare(b.name));

    mount(
      sidebar,
      link('← View as graph', '#/appgraph/graph'),
      el('div', { class: 'filter-group' }, [
        el('label', {}, ['Search']),
        el('input', {
          type: 'search',
          value: q,
          onchange: (e) => navigate({ q: (e.target as HTMLInputElement).value, kind, platform }),
        }),
      ]),
      el('div', { class: 'filter-group' }, [
        el('label', {}, ['Kind']),
        selectFilter(kinds, kind, (value) => navigate({ q, kind: value, platform })),
      ]),
      el('div', { class: 'filter-group' }, [
        el('label', {}, ['Platform']),
        selectFilter(platforms, platform, (value) => navigate({ q, kind, platform: value })),
      ]),
      el('div', { class: 'field-label' }, [`${filtered.length} of ${graph.nodes.length} nodes`]),
      filtered.length === 0
        ? empty('No matching nodes')
        : el(
            'ul',
            { class: 'result-list' },
            filtered.map((node) =>
              el(
                'li',
                {
                  class: `result-item${node.id === params.id ? ' active' : ''}`,
                  onclick: () => navigate({ q, kind, platform }, node.id),
                },
                [
                  badge(node.kind),
                  ' ',
                  el('span', { class: 'result-name' }, [node.name]),
                  node.subtype ? el('div', { class: 'result-path' }, [node.subtype]) : null,
                ]
              )
            )
          )
    );
  } catch (err) {
    mount(sidebar, errorBox(err instanceof Error ? err.message : String(err)));
  }
}

async function renderOverviewMain(main: HTMLElement): Promise<void> {
  try {
    const { graph } = await api.appGraph();
    mount(main, overviewFor(graph));
  } catch (err) {
    mount(main, errorBox(err instanceof Error ? err.message : String(err)));
  }
}

function overviewFor(graph: AppGraphWire): HTMLElement {
  return el('div', {}, [
    el('h2', {}, [`${graph.app.name} (${graph.platform})`]),
    el('div', { class: 'field-list' }, [
      el('div', { class: 'field-row' }, [
        el('div', { class: 'field-label' }, ['packageName']),
        el('div', { class: 'field-value' }, [graph.app.packageName || '—']),
      ]),
      el('div', { class: 'field-row' }, [
        el('div', { class: 'field-label' }, ['fidelity']),
        el('div', { class: 'field-value' }, [graph.fidelity]),
      ]),
      el('div', { class: 'field-row' }, [
        el('div', { class: 'field-label' }, ['supportedKinds']),
        el('div', { class: 'field-value' }, [graph.supportedKinds.join(', ')]),
      ]),
    ]),
    el('div', { class: 'section-title' }, [`Coverage warnings (${graph.coverageWarnings.length})`]),
    graph.coverageWarnings.length === 0
      ? el('div', { class: 'empty-state' }, ['None'])
      : table(
          ['message', 'ref'],
          graph.coverageWarnings.map((w) => [w.message, w.ref ? `${w.ref.file}${w.ref.symbol ? `#${w.ref.symbol}` : ''}` : '—'])
        ),
  ]);
}

function selectFilter(options: string[], current: string, onChange: (value: string) => void): HTMLSelectElement {
  return el(
    'select',
    { onchange: (e) => onChange((e.target as HTMLSelectElement).value) },
    [el('option', { value: '' }, ['(any)']), ...options.map((o) => el('option', { value: o, selected: o === current ? '' : undefined }, [o]))]
  );
}

function navigate(q: { q: string; kind: string; platform: string }, id?: string): void {
  const search = new URLSearchParams();
  if (q.q) search.set('q', q.q);
  if (q.kind) search.set('kind', q.kind);
  if (q.platform) search.set('platform', q.platform);
  const path = id ? `/appgraph/nodes/${encodeURIComponent(id)}` : '/appgraph';
  const qs = search.toString();
  location.hash = `#${path}${qs ? `?${qs}` : ''}`;
}
