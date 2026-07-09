import { api } from '../api';
import { badge, el, empty, errorBox, keysWithPositiveCount, link, mount, spinner } from '../render';
import { renderNodeDetail } from './codegraph-node-detail';

const PAGE_SIZE = 50;

export async function renderCodeGraphNodesView(
  container: HTMLElement,
  params: { id?: string },
  query: URLSearchParams
): Promise<void> {
  const q = query.get('q') ?? '';
  const kind = query.get('kind') ?? '';
  const language = query.get('language') ?? '';
  const file = query.get('file') ?? '';
  const offset = parseInt(query.get('offset') ?? '0', 10) || 0;

  const layout = el('div', { class: 'view-layout' }, [
    el('div', { class: 'view-sidebar' }, [spinner()]),
    el('div', { class: 'view-main' }, [params.id ? spinner() : empty('Select a node from the list')]),
  ]);
  mount(container, layout);

  const sidebar = layout.children[0] as HTMLElement;
  const main = layout.children[1] as HTMLElement;

  if (params.id) void renderNodeDetail(main, params.id);

  try {
    const status = await api.status();
    const stats = status.codegraph.stats;
    const availableKinds = keysWithPositiveCount(stats?.nodesByKind);
    const availableLanguages = keysWithPositiveCount(stats?.filesByLanguage);

    const search = await api.searchNodes({
      q,
      kind: kind ? [kind] : undefined,
      language: language ? [language] : undefined,
      file: file ? [file] : undefined,
      limit: PAGE_SIZE,
      offset,
    });

    mount(
      sidebar,
      link('← View as graph', '#/codegraph/graph'),
      el('div', { class: 'filter-group' }, [
        el('label', {}, ['Search']),
        el('input', {
          type: 'search',
          value: q,
          placeholder: 'name, kind:function, lang:go …',
          onchange: (e) => navigate({ q: (e.target as HTMLInputElement).value, kind, language, file }),
        }),
      ]),
      el('div', { class: 'filter-group' }, [
        el('label', {}, ['Kind']),
        selectFilter(availableKinds, kind, (value) => navigate({ q, kind: value, language, file })),
      ]),
      el('div', { class: 'filter-group' }, [
        el('label', {}, ['Language']),
        selectFilter(availableLanguages, language, (value) => navigate({ q, kind, language: value, file })),
      ]),
      el('div', { class: 'filter-group' }, [
        el('label', {}, ['File contains']),
        el('input', {
          type: 'text',
          value: file,
          placeholder: 'src/foo/',
          onchange: (e) => navigate({ q, kind, language, file: (e.target as HTMLInputElement).value }),
        }),
      ]),
      el(
        'ul',
        { class: 'result-list' },
        search.results.map(({ node }) =>
          el(
            'li',
            {
              class: `result-item${node.id === params.id ? ' active' : ''}`,
              onclick: () => navigate({ q, kind, language, file, offset: String(offset) }, node.id),
            },
            [
              badge(node.kind),
              ' ',
              el('span', { class: 'result-name' }, [node.name]),
              el('div', { class: 'result-path' }, [`${node.filePath}:${node.startLine}`]),
            ]
          )
        )
      ),
      el('div', { class: 'pagination' }, [
        el(
          'button',
          {
            disabled: offset <= 0 ? '' : undefined,
            onclick: () => navigate({ q, kind, language, file, offset: String(Math.max(0, offset - PAGE_SIZE)) }, params.id),
          },
          ['← Prev']
        ),
        `${offset + 1}–${offset + search.results.length}`,
        el(
          'button',
          {
            disabled: search.hasMore ? undefined : '',
            onclick: () => navigate({ q, kind, language, file, offset: String(offset + PAGE_SIZE) }, params.id),
          },
          ['Next →']
        ),
      ])
    );

    if (search.results.length === 0) {
      mount(sidebar.querySelector('.result-list') ?? sidebar, empty('No matching nodes'));
    }
  } catch (err) {
    mount(sidebar, errorBox(err instanceof Error ? err.message : String(err)));
  }
}

function selectFilter(options: string[], current: string, onChange: (value: string) => void): HTMLSelectElement {
  return el(
    'select',
    { onchange: (e) => onChange((e.target as HTMLSelectElement).value) },
    [el('option', { value: '' }, ['(any)']), ...options.map((o) => el('option', { value: o, selected: o === current ? '' : undefined }, [o]))]
  );
}

function navigate(q: { q: string; kind: string; language: string; file: string; offset?: string }, id?: string): void {
  const search = new URLSearchParams();
  if (q.q) search.set('q', q.q);
  if (q.kind) search.set('kind', q.kind);
  if (q.language) search.set('language', q.language);
  if (q.file) search.set('file', q.file);
  if (q.offset && q.offset !== '0') search.set('offset', q.offset);
  const path = id ? `/codegraph/nodes/${encodeURIComponent(id)}` : '/codegraph/nodes';
  const qs = search.toString();
  location.hash = `#${path}${qs ? `?${qs}` : ''}`;
}
