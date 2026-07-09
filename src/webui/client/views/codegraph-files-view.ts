import { api } from '../api';
import { badge, el, empty, errorBox, keysWithPositiveCount, link, mount, spinner, table } from '../render';

const PAGE_SIZE = 100;

export async function renderCodeGraphFilesView(container: HTMLElement, query: URLSearchParams): Promise<void> {
  const q = query.get('q') ?? '';
  const language = query.get('language') ?? '';
  const offset = parseInt(query.get('offset') ?? '0', 10) || 0;

  mount(container, el('div', { class: 'view' }, [spinner()]));

  try {
    const status = await api.status();
    const stats = status.codegraph.stats;
    const languages = keysWithPositiveCount(stats?.filesByLanguage);

    const data = await api.listFiles({ q: q || undefined, language: language || undefined, limit: PAGE_SIZE, offset });

    mount(
      container,
      el('div', { class: 'view' }, [
        el('h2', {}, ['Files']),
        el('div', { class: 'toolbar' }, [
          el('input', {
            type: 'search',
            value: q,
            placeholder: 'filter by path…',
            onchange: (e) => navigate({ q: (e.target as HTMLInputElement).value, language }),
          }),
          selectFilter(languages, language, (value) => navigate({ q, language: value })),
        ]),
        data.files.length === 0
          ? empty('No matching files')
          : table(
              ['path', 'language', 'size', 'nodes', 'errors'],
              data.files.map((f) => [
                link(f.path, `#/codegraph/nodes?file=${encodeURIComponent(f.path)}`),
                f.language,
                formatBytes(f.size),
                String(f.nodeCount),
                f.errors && f.errors.length > 0 ? badge(String(f.errors.length), 'error') : '—',
              ])
            ),
        el('div', { class: 'pagination' }, [
          el(
            'button',
            {
              disabled: offset <= 0 ? '' : undefined,
              onclick: () => navigate({ q, language, offset: String(Math.max(0, offset - PAGE_SIZE)) }),
            },
            ['← Prev']
          ),
          `${data.total === 0 ? 0 : offset + 1}–${offset + data.files.length} of ${data.total}`,
          el(
            'button',
            {
              disabled: offset + PAGE_SIZE >= data.total ? '' : undefined,
              onclick: () => navigate({ q, language, offset: String(offset + PAGE_SIZE) }),
            },
            ['Next →']
          ),
        ]),
      ])
    );
  } catch (err) {
    mount(container, el('div', { class: 'view' }, [errorBox(err instanceof Error ? err.message : String(err))]));
  }
}

function selectFilter(options: string[], current: string, onChange: (value: string) => void): HTMLSelectElement {
  return el(
    'select',
    { onchange: (e) => onChange((e.target as HTMLSelectElement).value) },
    [el('option', { value: '' }, ['(any)']), ...options.map((o) => el('option', { value: o, selected: o === current ? '' : undefined }, [o]))]
  );
}

function navigate(q: { q: string; language: string; offset?: string }): void {
  const search = new URLSearchParams();
  if (q.q) search.set('q', q.q);
  if (q.language) search.set('language', q.language);
  if (q.offset && q.offset !== '0') search.set('offset', q.offset);
  const qs = search.toString();
  location.hash = `#/codegraph/files${qs ? `?${qs}` : ''}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
