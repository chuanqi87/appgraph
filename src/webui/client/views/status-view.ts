import { api, StatusResponse } from '../api';
import { el, mount, errorBox, spinner, link } from '../render';

export async function renderStatusView(container: HTMLElement): Promise<void> {
  mount(container, el('div', { class: 'view' }, [spinner()]));
  try {
    const status = await api.status();
    mount(container, el('div', { class: 'view' }, [
      el('h2', {}, ['Project Overview']),
      el('div', { class: 'field-list' }, [
        el('div', { class: 'field-row' }, [
          el('div', { class: 'field-label' }, ['Project root']),
          el('div', { class: 'field-value' }, [status.projectRoot]),
        ]),
      ]),
      renderCodeGraphSection(status),
      await renderAppGraphSection(status),
    ]));
  } catch (err) {
    mount(container, el('div', { class: 'view' }, [errorBox(message(err))]));
  }
}

function renderCodeGraphSection(status: StatusResponse): HTMLElement {
  const stats = status.codegraph.stats;
  if (!status.codegraph.indexed || !stats) {
    return el('div', {}, [
      el('h3', {}, ['CodeGraph']),
      el('p', { class: 'empty-state' }, [
        'This project has no CodeGraph index yet. Run ',
        el('code', {}, ['codegraph init']),
        ' (and ',
        el('code', {}, ['codegraph index']),
        ') in the project root, then reload this page.',
      ]),
    ]);
  }

  return el('div', {}, [
    el('h3', {}, ['CodeGraph', ' ', link('View graph →', '#/codegraph/graph')]),
    el('div', { class: 'stats-grid' }, [
      statCard(stats.fileCount, 'Files'),
      statCard(stats.nodeCount, 'Nodes'),
      statCard(stats.edgeCount, 'Edges'),
      statCard(`${(stats.dbSizeBytes / 1024 / 1024).toFixed(1)} MB`, 'Index size'),
    ]),
    el('div', { class: 'section-title' }, ['Nodes by kind']),
    kindBarList(stats.nodesByKind),
    el('div', { class: 'section-title' }, ['Edges by kind']),
    kindBarList(stats.edgesByKind),
    el('div', { class: 'section-title' }, ['Files by language']),
    kindBarList(stats.filesByLanguage),
  ]);
}

async function renderAppGraphSection(status: StatusResponse): Promise<HTMLElement> {
  if (!status.appgraph.built) {
    return el('div', {}, [
      el('h3', {}, ['AppGraph']),
      el('p', { class: 'empty-state' }, [
        'No ',
        el('code', {}, ['.appgraph/app-graph.json']),
        ' yet. Run ',
        el('code', {}, ['appgraph build <path>']),
        ', then reload this page.',
      ]),
    ]);
  }

  try {
    const { graph } = await api.appGraph();
    const byKind: Record<string, number> = {};
    for (const n of graph.nodes) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
    const count = (kind: string): number => byKind[kind] ?? 0;
    const navEdges = graph.edges.filter((e) => e.kind === 'navigates_to').length;
    return el('div', {}, [
      el('h3', {}, ['AppGraph', ' ', link('View architecture →', '#/appgraph')]),
      el('div', { class: 'stats-grid' }, [
        statCard(graph.app.name, 'App'),
        statCard(graph.platform, 'Platform'),
        statCard(count('ArchModule'), 'Modules'),
        statCard(count('Feature'), 'Features'),
        statCard(count('Screen'), 'Screens'),
        statCard(count('Capability'), 'Capabilities'),
        statCard(navEdges, 'Nav edges'),
        statCard(graph.coverageWarnings.length, 'Warnings'),
      ]),
      el('div', { class: 'section-title' }, ['Nodes by kind']),
      kindBarList(byKind),
    ]);
  } catch (err) {
    return errorBox(message(err));
  }
}

function statCard(value: number | string, label: string): HTMLElement {
  return el('div', { class: 'stat-card' }, [
    el('div', { class: 'stat-value' }, [String(value)]),
    el('div', { class: 'stat-label' }, [label]),
  ]);
}

function kindBarList(counts: Record<string, number>): HTMLElement {
  const entries = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  const max = entries.length > 0 ? entries[0][1] : 1;
  return el(
    'div',
    { class: 'kind-bar-list' },
    entries.map(([kind, count]) =>
      el('div', { class: 'kind-bar-row' }, [
        el('div', {}, [kind]),
        el('div', { class: 'kind-bar-track' }, [
          el('div', { class: 'kind-bar-fill', style: `width:${Math.round((count / max) * 100)}%` }, []),
        ]),
        el('div', {}, [String(count)]),
      ])
    )
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
