import { api } from '../api';
import { badge, el, empty, errorBox, keysWithPositiveCount, link, mount, spinner, table } from '../render';

const PAGE_SIZE = 100;
const PROVENANCES = ['tree-sitter', 'scip', 'heuristic'];

export async function renderCodeGraphEdgesView(container: HTMLElement, query: URLSearchParams): Promise<void> {
  const kind = query.get('kind') ?? '';
  const provenance = query.get('provenance') ?? '';
  const offset = parseInt(query.get('offset') ?? '0', 10) || 0;

  mount(container, el('div', { class: 'view' }, [spinner()]));

  try {
    const status = await api.status();
    const stats = status.codegraph.stats;
    const kinds = keysWithPositiveCount(stats?.edgesByKind);

    const data = await api.listEdges({ kind: kind || undefined, provenance: provenance || undefined, limit: PAGE_SIZE, offset });

    mount(
      container,
      el('div', { class: 'view' }, [
        el('h2', {}, ['Edges']),
        el('div', { class: 'toolbar' }, [
          selectFilter('Kind', kinds, kind, (value) => navigate({ kind: value, provenance })),
          selectFilter('Provenance', PROVENANCES, provenance, (value) => navigate({ kind, provenance: value })),
        ]),
        data.edges.length === 0
          ? empty('No matching edges')
          : table(
              ['kind', 'source', 'target', 'provenance', 'location'],
              data.edges.map(({ edge, source, target }) => [
                badge(edge.kind),
                source ? link(`${source.name} (${source.kind})`, `#/codegraph/nodes/${encodeURIComponent(source.id)}`) : '(deleted)',
                target ? link(`${target.name} (${target.kind})`, `#/codegraph/nodes/${encodeURIComponent(target.id)}`) : '(deleted)',
                edge.provenance ?? '—',
                edge.line !== undefined ? `${edge.line}:${edge.column ?? 0}` : '—',
              ])
            ),
        el('div', { class: 'pagination' }, [
          el(
            'button',
            { disabled: offset <= 0 ? '' : undefined, onclick: () => navigate({ kind, provenance, offset: String(Math.max(0, offset - PAGE_SIZE)) }) },
            ['← Prev']
          ),
          `${data.total === 0 ? 0 : offset + 1}–${offset + data.edges.length} of ${data.total}`,
          el(
            'button',
            { disabled: offset + PAGE_SIZE >= data.total ? '' : undefined, onclick: () => navigate({ kind, provenance, offset: String(offset + PAGE_SIZE) }) },
            ['Next →']
          ),
        ]),
      ])
    );
  } catch (err) {
    mount(container, el('div', { class: 'view' }, [errorBox(err instanceof Error ? err.message : String(err))]));
  }
}

function selectFilter(label: string, options: string[], current: string, onChange: (value: string) => void): HTMLElement {
  return el('div', { class: 'filter-group' }, [
    el('label', {}, [label]),
    el(
      'select',
      { onchange: (e) => onChange((e.target as HTMLSelectElement).value) },
      [el('option', { value: '' }, ['(any)']), ...options.map((o) => el('option', { value: o, selected: o === current ? '' : undefined }, [o]))]
    ),
  ]);
}

function navigate(q: { kind: string; provenance: string; offset?: string }): void {
  const search = new URLSearchParams();
  if (q.kind) search.set('kind', q.kind);
  if (q.provenance) search.set('provenance', q.provenance);
  if (q.offset && q.offset !== '0') search.set('offset', q.offset);
  const qs = search.toString();
  location.hash = `#/codegraph/edges${qs ? `?${qs}` : ''}`;
}
