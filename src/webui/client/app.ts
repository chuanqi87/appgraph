import { api, StatusResponse } from './api';
import { el, mount } from './render';
import { renderStatusView } from './views/status-view';
import { renderCodeGraphNodesView } from './views/codegraph-nodes-view';
import { renderCodeGraphFilesView } from './views/codegraph-files-view';
import { renderCodeGraphEdgesView } from './views/codegraph-edges-view';
import { renderAppGraphView } from './views/appgraph-view';
import { renderAppGraphModuleView } from './views/appgraph-module-view';
import { renderAppNodeDetail } from './views/appgraph-node-detail';
import { renderGraphView } from './views/graph-view';

type RouteRender = (
  container: HTMLElement,
  params: Record<string, string>,
  query: URLSearchParams
) => void | Promise<void>;

interface Route {
  pattern: RegExp;
  paramNames: string[];
  render: RouteRender;
}

const routes: Route[] = [];

function addRoute(path: string, render: RouteRender): void {
  const paramNames: string[] = [];
  const source = path
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        paramNames.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment;
    })
    .join('/');
  routes.push({ pattern: new RegExp(`^${source}$`), paramNames, render });
}

addRoute('/', (c) => renderStatusView(c));
addRoute('/codegraph', (c, _p, q) => renderCodeGraphNodesView(c, {}, q));
addRoute('/codegraph/nodes', (c, _p, q) => renderCodeGraphNodesView(c, {}, q));
addRoute('/codegraph/nodes/:id', (c, p, q) => renderCodeGraphNodesView(c, { id: p.id }, q));
addRoute('/codegraph/files', (c, _p, q) => renderCodeGraphFilesView(c, q));
addRoute('/codegraph/edges', (c, _p, q) => renderCodeGraphEdgesView(c, q));
addRoute('/codegraph/graph', (c, _p, q) => renderGraphView(c, { source: 'codegraph', query: q }));
// AppGraph drill-down: L1 overview (default) → L2 module → L3 node → graph.
// The overview is the landing (not the graph) so the architecture reads first.
addRoute('/appgraph', (c) => renderAppGraphView(c));
addRoute('/appgraph/modules/:id', (c, p) => renderAppGraphModuleView(c, p.id));
addRoute('/appgraph/nodes/:id', (c, p) => renderAppNodeDetail(c, p.id));
addRoute('/appgraph/graph', (c, _p, q) => renderGraphView(c, { source: 'appgraph', query: q }));

let currentStatus: StatusResponse | null = null;

function parseHash(): { path: string; query: URLSearchParams } {
  const raw = location.hash.replace(/^#/, '');
  const [path, search] = raw.split('?');
  return { path: path && path.length > 0 ? path : '/', query: new URLSearchParams(search ?? '') };
}

async function route(): Promise<void> {
  const { path, query } = parseHash();
  const appEl = document.getElementById('app');
  if (!appEl) return;

  renderTabs(path);

  for (const r of routes) {
    const match = r.pattern.exec(path);
    if (!match) continue;
    const params: Record<string, string> = {};
    r.paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(match[i + 1] ?? '');
    });
    await r.render(appEl, params, query);
    return;
  }
  mount(appEl, el('div', { class: 'empty-state' }, [`No route for "${path}"`]));
}

function renderTabs(currentPath: string): void {
  const tabsEl = document.getElementById('tabs');
  if (!tabsEl) return;
  const section = currentPath.startsWith('/appgraph')
    ? 'appgraph'
    : currentPath.startsWith('/codegraph')
      ? 'codegraph'
      : 'status';

  const tab = (label: string, href: string, key: string, disabled: boolean): HTMLElement =>
    el(
      'a',
      {
        href: disabled ? undefined : `#${href}`,
        class: `tab${section === key ? ' active' : ''}${disabled ? ' disabled' : ''}`,
      },
      [label]
    );

  mount(
    tabsEl,
    tab('Overview', '/', 'status', false),
    // Both layers default straight into their graph view — that's the
    // intuitive "show me the structure" entry point; the table/list views
    // are one click away from there ("browse as table →").
    tab('CodeGraph', '/codegraph/graph', 'codegraph', !currentStatus?.codegraph.indexed),
    tab('AppGraph', '/appgraph', 'appgraph', !currentStatus?.appgraph.built)
  );
}

async function init(): Promise<void> {
  currentStatus = await api.status().catch(() => null);

  const pathEl = document.getElementById('project-path');
  if (pathEl && currentStatus) pathEl.textContent = currentStatus.projectRoot;

  if (!location.hash) {
    location.hash = currentStatus?.appgraph.built
      ? '#/appgraph'
      : currentStatus?.codegraph.indexed
        ? '#/codegraph/graph'
        : '#/';
  }

  window.addEventListener('hashchange', () => void route());
  await route();
}

void init();
