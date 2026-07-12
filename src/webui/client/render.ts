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

export function badge(text: string, kind?: string): HTMLElement {
  return el('span', { class: `badge${kind ? ` badge-${slugify(kind)}` : ''}` }, [text]);
}

/** A small colored pill — `tone` picks a semantic class (ok/info/warn/danger/accent).
 *  Use for role flags, trust tags, edge-kind labels. Distinct from `badge`
 *  (neutral, border-only) so chips read as "categorical/tagged" not "neutral label". */
export function chip(text: string, tone?: string): HTMLElement {
  return el('span', { class: `chip${tone ? ` chip-${tone}` : ''}` }, [text]);
}

/** `kind`-colored chip using a literal hex color (from visual.ts palettes),
 *  so node-kind tags match their canvas color. */
export function colorChip(text: string, color: string): HTMLElement {
  return el('span', { class: 'chip chip-color', style: `--chip-color:${color}` }, [text]);
}

/** A titled section wrapper with an optional count in the header. */
export function section(title: string, count?: number, ...children: Child[]): HTMLElement {
  const header = el('div', { class: 'section-title' }, [title, count !== undefined ? ` (${count})` : '']);
  return el('section', { class: 'rel-section' }, [header, ...children]);
}

export function empty(message: string): HTMLElement {
  return el('div', { class: 'empty-state' }, [message]);
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
