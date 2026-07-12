/**
 * Right-side node list panel — light-themed, collapsible.
 * Lists all visible nodes at the current zoom level, synced with
 * the graph's filters. Clicking a row focuses the node in the graph.
 */

import { el, mount } from './render';

type Level = 0 | 1 | 2;

export interface NodeListCallbacks {
  onNodeClick: (id: string) => void;
}

export interface NodeListItem {
  id: string;
  label: string;
  kind: string;
  color: string;
  data?: unknown;
}

export function renderNodeList(
  host: HTMLElement,
  level: Level,
  nodes: NodeListItem[],
  callbacks: NodeListCallbacks,
): void {
  host.innerHTML = '';

  const titleMap = ['Migration Units', 'Modules', 'Code Symbols'];
  const title = titleMap[level] || 'Nodes';

  const header = el('div', { class: 'node-list-header' }, [
    el('h1', {}, [title]),
    el('div', { class: 'text-xs text-zinc-500' }, [`${nodes.length} nodes`]),
  ]);

  const searchInput = el('input', {
    class: 'list-search',
    type: 'text',
    placeholder: 'Filter list…',
  }, []) as HTMLInputElement;

  const sortSelect = el('select', { class: 'list-search' }, []) as HTMLSelectElement;
  const sortOptions = [
    { value: 'name', label: 'Sort by name' },
    { value: 'kind', label: 'Sort by kind' },
  ];
  for (const opt of sortOptions) {
    sortSelect.appendChild(el('option', { value: opt.value }, [opt.label]));
  }

  const controls = el('div', { class: 'node-list-controls' }, [searchInput, sortSelect]);

  const rowsHost = el('div', { class: 'flex-1 overflow-y-auto scrollbar-thin' }, []);

  function renderRows(filter: string, sortBy: string): void {
    let filtered = nodes;
    if (filter) {
      const q = filter.toLowerCase();
      filtered = nodes.filter((n) => n.label.toLowerCase().includes(q));
    }

    let sorted = [...filtered];
    if (sortBy === 'name') {
      sorted.sort((a, b) => a.label.localeCompare(b.label));
    } else if (sortBy === 'kind') {
      sorted.sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));
    }

    rowsHost.innerHTML = '';

    if (sorted.length === 0) {
      rowsHost.appendChild(el('div', { class: 'px-3.5 py-5 text-center text-zinc-400 text-xs' }, ['No matching nodes']));
      return;
    }

    for (const node of sorted) {
      const row = el('div', {
        class: 'list-row',
        style: `border-left-color:${node.color}`,
        onclick: () => callbacks.onNodeClick(node.id),
      }, [
        el('div', { class: 'flex items-center justify-between gap-1.5' }, [
          el('span', { class: 'text-xs font-semibold text-zinc-800 break-all' }, [node.label]),
          el('span', {
            class: 'inline-block text-[10px] px-1.5 py-0.5 rounded-full text-white whitespace-nowrap',
            style: `background:${node.color}`,
          }, [node.kind]),
        ]),
      ]);
      rowsHost.appendChild(row);
    }
  }

  searchInput.addEventListener('input', () => renderRows(searchInput.value, sortSelect.value));
  sortSelect.addEventListener('change', () => renderRows(searchInput.value, sortSelect.value));

  renderRows('', 'name');

  host.append(header, controls, rowsHost);
}
