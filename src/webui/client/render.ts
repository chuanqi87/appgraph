/**
 * Tiny DOM-construction helpers — no framework. The UI is a handful of
 * list+detail screens, which plain DOM calls handle without a virtual-DOM
 * layer; `el()` just removes the createElement/setAttribute/appendChild
 * boilerplate.
 */

export type Child = Node | string | number | null | undefined | false;
export type Attrs = Record<string, string | EventListener | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: Child[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'class') {
      node.className = value as string;
    } else {
      node.setAttribute(key, value as string);
    }
  }
  append(node, children);
  return node;
}

function append(node: HTMLElement, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

export function mount(container: HTMLElement, ...children: Child[]): void {
  container.replaceChildren();
  append(container, children);
}

export function table(headers: string[], rows: Child[][], opts: { className?: string } = {}): HTMLTableElement {
  return el('table', { class: `data-table${opts.className ? ` ${opts.className}` : ''}` }, [
    el('thead', {}, [el('tr', {}, headers.map((h) => el('th', {}, [h])))]),
    el(
      'tbody',
      {},
      rows.map((cells) => el('tr', {}, cells.map((c) => el('td', {}, [c]))))
    ),
  ]);
}

export function fieldRow(label: string, value: Child[]): HTMLElement {
  return el('div', { class: 'field-row' }, [
    el('div', { class: 'field-label' }, [label]),
    el('div', { class: 'field-value' }, value),
  ]);
}

export function fieldList(rows: Array<[string, Child[]]>): HTMLElement {
  return el(
    'div',
    { class: 'field-list' },
    rows.map(([label, value]) => fieldRow(label, value))
  );
}

export function jsonBlock(value: unknown): HTMLElement {
  return el('pre', { class: 'json-block' }, [JSON.stringify(value, null, 2)]);
}

export function badge(text: string, kind?: string): HTMLElement {
  return el('span', { class: `badge${kind ? ` badge-${slugify(kind)}` : ''}` }, [text]);
}

export function badgeList(items: string[], kind?: string): HTMLElement {
  return el(
    'div',
    { class: 'badge-list' },
    items.map((i) => badge(i, kind))
  );
}

/** A small colored pill — `tone` picks a semantic class (ok/info/warn/danger/accent).
 *  Use for role flags, trust tags, edge-kind labels. Distinct from `badge`
 *  (neutral, border-only) so chips read as "categorical/tagged" not "neutral label". */
export function chip(text: string, tone?: string): HTMLElement {
  return el('span', { class: `chip${tone ? ` chip-${tone}` : ''}` }, [text]);
}

/** A clickable chip — navigates the hash router. */
export function chipLink(text: string, href: string, tone?: string): HTMLAnchorElement {
  return el('a', { href, class: `chip chip-link${tone ? ` chip-${tone}` : ''}` }, [text]);
}

/** `kind`-colored chip using a literal hex color (from visual.ts palettes),
 *  so node-kind tags match their canvas color. */
export function colorChip(text: string, color: string): HTMLElement {
  return el('span', { class: 'chip chip-color', style: `--chip-color:${color}` }, [text]);
}

export function colorChipLink(text: string, href: string, color: string): HTMLAnchorElement {
  return el('a', { href, class: 'chip chip-link chip-color', style: `--chip-color:${color}` }, [text]);
}

/** Breadcrumb trail: each crumb is a link except the last (current page). */
export function breadcrumb(parts: Array<{ label: string; href?: string }>): HTMLElement {
  return el(
    'nav',
    { class: 'breadcrumb' },
    parts.flatMap((p, i) => {
      const items: HTMLElement[] = [];
      if (i > 0) items.push(el('span', { class: 'breadcrumb-sep' }, ['/']));
      items.push(
        p.href
          ? el('a', { href: p.href, class: 'breadcrumb-link' }, [p.label])
          : el('span', { class: 'breadcrumb-current' }, [p.label])
      );
      return items;
    })
  );
}

/** A titled section wrapper with an optional count in the header. */
export function section(title: string, count?: number, ...children: Child[]): HTMLElement {
  const header = el('div', { class: 'section-title' }, [title, count !== undefined ? ` (${count})` : '']);
  return el('section', { class: 'rel-section' }, [header, ...children]);
}

/** A horizontal trust meter: filled portion = value (0..1). For provenance/
 *  confidence — surfaces the B-series "is this lifted or manifest?" distinction
 *  visually instead of as a bare number. */
export function meter(value: number, label: string): HTMLElement {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return el('div', { class: 'meter' }, [
    el('div', { class: 'meter-track' }, [el('div', { class: 'meter-fill', style: `width:${pct.toFixed(0)}%` })]),
    el('div', { class: 'meter-label' }, [label]),
  ]);
}

export function link(text: string, href: string, opts: Attrs = {}): HTMLAnchorElement {
  return el('a', { href, class: 'link', ...opts }, [text]);
}

export function empty(message: string): HTMLElement {
  return el('div', { class: 'empty-state' }, [message]);
}

/** Sorted keys with a positive count — the recurring "which kinds/languages
 *  actually occur" pattern for building filter-dropdown option lists from a
 *  GraphStats breakdown. `Object.entries` sidesteps indexing a `Record` keyed
 *  by a literal-union type (NodeKind, Language, ...) with a plain string. */
export function keysWithPositiveCount(counts: Record<string, number> | null | undefined): string[] {
  if (!counts) return [];
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k]) => k)
    .sort();
}

export function errorBox(message: string): HTMLElement {
  return el('div', { class: 'error-box' }, [message]);
}

export function spinner(): HTMLElement {
  return el('div', { class: 'spinner' }, ['Loading…']);
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}
