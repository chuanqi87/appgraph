/**
 * AppGraph L1 — the architecture overview, the new landing for /appgraph.
 *
 * Replaces the old flat sidebar-list-of-everything. The centerpiece is an
 * interactive module-dependency graph (ArchModule + depends_on) — the
 * "high-level architecture at a glance" every knowledge-graph UI leads with.
 * Around it: a trust strip (provenance breakdown), summary stat cards, and
 * three rails — module chips (→ drill-down), feature clusters by role
 * (subdivision/aligned/cross-module), the capability inventory (with HarmonyOS
 * targets), and the anti-silence coverage warnings (nav sparse, framework
 * fingerprints). This is the entry to the L1→L2 (module)→L3 (node) drill-down.
 */

import { api } from '../api';
import { buildAppGraphModel, nodeKindCount, roleOf, type AppGraphModel } from '../appgraph-model';
import { chip, colorChip, colorChipLink, el, empty, errorBox, link, mount, section, spinner } from '../render';
import { mountAppCanvas } from './graph-view';
import { featureRoleTone, nodeColor, provenanceLabel } from '../visual';
import type { AppNodeWire } from '../../wire-types';

export async function renderAppGraphView(container: HTMLElement): Promise<void> {
  mount(container, spinner());
  try {
    const { graph } = await api.appGraph();
    const model = buildAppGraphModel(graph);
    mount(container, overview(model));
  } catch (err) {
    mount(container, errorBox(err instanceof Error ? err.message : String(err)));
  }
}

function overview(model: AppGraphModel): HTMLElement {
  const g = model.graph;
  return el('div', { class: 'view app-overview' }, [
    el('div', { class: 'overview-header' }, [
      el('h2', {}, [`${g.app.name}`]),
      el('span', { class: 'badge' }, [g.platform]),
      g.app.packageName ? el('span', { class: 'field-value', style: 'font-size:12px' }, [g.app.packageName]) : null,
      el('span', { class: 'badge badge-info', style: 'margin-left:auto' }, [`fidelity: ${g.fidelity}`]),
    ]),
    trustStrip(model),
    statCards(model),
    el('div', { class: 'overview-grid' }, [
      el('div', { class: 'overview-main' }, [moduleGraphCenterpiece(model)]),
      el('div', { class: 'overview-rail' }, [
        modulesRail(model),
        featuresRail(model),
        capabilitiesRail(model),
        coverageRail(model),
      ]),
    ]),
  ]);
}

/** Provenance breakdown — the trust story at a glance. Manifest facts are
 *  ground truth; lifted/llm are advisory. Surfaces the B-series distinction. */
function trustStrip(model: AppGraphModel): HTMLElement {
  const counts = model.provenanceCounts;
  const order = ['manifest', 'source-static', 'lifted', 'llm'];
  const total = g_nodeTotal(model);
  return el('div', { class: 'trust-strip' }, [
    el('span', { class: 'field-label' }, ['Trust']),
    ...order
      .filter((p) => (counts[p] ?? 0) > 0)
      .map((p) => chip(`${provenanceLabel(p)} ${counts[p]}`, p === 'manifest' ? 'ok' : p === 'llm' ? 'warn' : 'info')),
    el('span', { class: 'field-label', style: 'margin-left:auto' }, [`${total} nodes`]),
  ]);
}

function g_nodeTotal(model: AppGraphModel): number {
  return model.graph.nodes.length;
}

function statCards(model: AppGraphModel): HTMLElement {
  const g = model.graph;
  const navEdges = g.edges.filter((e) => e.kind === 'navigates_to').length;
  const card = (v: number | string, label: string, href?: string): HTMLElement =>
    el('div', { class: 'stat-card' }, [
      el('div', { class: 'stat-value' }, [href ? link(String(v), href) : String(v)]),
      el('div', { class: 'stat-label' }, [label]),
    ]);
  return el('div', { class: 'stats-grid' }, [
    card(nodeKindCount(model, 'ArchModule'), 'Modules', '#/appgraph'),
    card(nodeKindCount(model, 'Feature'), 'Features'),
    card(nodeKindCount(model, 'Screen'), 'Screens', '#/appgraph/graph?view=screen-flow'),
    card(nodeKindCount(model, 'Capability'), 'Capabilities'),
    card(nodeKindCount(model, 'Permission'), 'Permissions'),
    card(navEdges, 'Nav edges', '#/appgraph/graph?view=screen-flow'),
    card(g.coverageWarnings.length, 'Warnings'),
  ]);
}

/** The centerpiece: module dependency graph (modules + depends_on). Sized by
 *  symbol count, edges colored by declared/lifted (semantic palette in
 *  visual.ts). Click a module → drill into it. */
function moduleGraphCenterpiece(model: AppGraphModel): HTMLElement {
  const host = el('div', { class: 'mini-graph-host' }, []);
  const wrap = el('div', { class: 'overview-card' }, [
    el('div', { class: 'overview-card-head' }, [
      el('div', { class: 'overview-card-title' }, ['Module dependency graph']),
      link('Open full graph →', '#/appgraph/graph?view=module'),
    ]),
    host,
    el('div', { class: 'overview-card-foot' }, [
      'Click a module to drill in · ',
      colorChip('depends_on', nodeColor('ArchModule')),
      ' solid = declared · dashed = lifted · red = suspect',
    ]),
  ]);
  // Defer the sigma mount until the host is in the DOM so it has a size.
  setTimeout(() => {
    if (host.clientWidth === 0) return;
    mountAppCanvas(model, 'module', host, {
      onNodeClick: (id) => {
        location.hash = `#/appgraph/modules/${encodeURIComponent(id)}`;
      },
    });
  }, 0);
  return wrap;
}

/** Modules rail — clickable chips that drill into each module. */
function modulesRail(model: AppGraphModel): HTMLElement {
  const modules = model.modules;
  if (modules.length === 0) return empty('No modules detected.');
  return section('Modules', modules.length, ...modules.map((m) => moduleChip(model, m)));
}

function moduleChip(model: AppGraphModel, m: AppNodeWire): HTMLElement {
  const href = `#/appgraph/modules/${encodeURIComponent(m.id)}`;
  const sc = typeof m.attrs?.symbolCount === 'number' ? m.attrs.symbolCount : undefined;
  const deps = (model.outByNode.get(m.id) ?? []).filter((e) => e.kind === 'depends_on').length;
  return el('div', { class: 'rail-item' }, [
    colorChipLink(m.name, href, nodeColor(m.kind)),
    sc !== undefined ? chip(`${sc} sym`, 'info') : null,
    deps > 0 ? chip(`${deps} deps`, 'info') : null,
  ]);
}

/** Features by role — the M2 community overlay (subdivision/aligned/cross). */
function featuresRail(model: AppGraphModel): HTMLElement {
  const byRole = model.featuresByRole;
  const roles = ['subdivision', 'cross-module', 'aligned'].filter((r) => byRole.has(r));
  if (roles.length === 0) return section('Features', 0, empty('No feature clusters detected.'));
  const groups: HTMLElement[] = [];
  let total = 0;
  for (const role of roles) {
    const feats = byRole.get(role) ?? [];
    total += feats.length;
    const tone = featureRoleTone(role);
    groups.push(
      el('div', { class: 'chip-group' }, [
        el('div', { class: 'chip-group-title' }, [chip(tone.label, tone.tone), ` · ${feats.length}`]),
        el('div', { class: 'chip-list' }, feats.map((f) => featureChip(f))),
      ])
    );
  }
  return section('Features', total, ...groups);
}

function featureChip(f: AppNodeWire): HTMLElement {
  const href = `#/appgraph/nodes/${encodeURIComponent(f.id)}`;
  const size = typeof f.attrs?.size === 'number' ? `${f.attrs.size} files` : null;
  const cohesion = typeof f.attrs?.cohesion === 'number' ? `cohesion ${f.attrs.cohesion}` : null;
  return el('span', { class: 'chip-cluster' }, [
    colorChipLink(f.name, href, nodeColor(f.kind)),
    size ? chip(size, 'info') : null,
    cohesion ? chip(cohesion) : null,
  ]);
}

/** Capability inventory — the cross-platform match anchors, with their
 *  HarmonyOS target API where mapped (the migration-relevant layer). */
function capabilitiesRail(model: AppGraphModel): HTMLElement {
  const caps = model.capabilities;
  if (caps.length === 0) return section('Capabilities', 0, empty('No capabilities detected.'));
  return section(
    'Capabilities',
    caps.length,
    el('div', { class: 'chip-list' }, caps.map((c) => capabilityChip(c)))
  );
}

function capabilityChip(c: AppNodeWire): HTMLElement {
  const href = `#/appgraph/nodes/${encodeURIComponent(c.id)}`;
  const target = typeof c.attrs?.harmonyModule === 'string' && c.attrs.harmonyModule ? c.attrs.harmonyModule : null;
  return el('span', { class: 'chip-cluster' }, [
    colorChipLink(c.name, href, nodeColor(c.kind)),
    target ? chip(`→ ${target}`, 'ok') : chip('unmapped', 'warn'),
  ]);
}

/** Coverage warnings — the anti-silence panel. These are the trust signals
 *  (nav sparse, Circuit/Cicerone framework fingerprint, unresolvable refs)
 *  that the P0 fixes added; surfacing them on the landing page is what makes
 *  the graph honest instead of quietly incomplete. */
function coverageRail(model: AppGraphModel): HTMLElement {
  const ws = model.graph.coverageWarnings;
  if (ws.length === 0) return section('Coverage warnings', 0, empty('None — extraction looks complete.'));
  return section(
    'Coverage warnings',
    ws.length,
    el(
      'ul',
      { class: 'warn-list' },
      ws.map((w) =>
        el('li', { class: 'warn-item' }, [
          el('span', { class: 'chip chip-warn' }, ['!']),
          el('span', { class: 'warn-message' }, [w.message]),
          w.ref ? el('span', { class: 'result-path' }, [`${w.ref.file}${w.ref.symbol ? `#${w.ref.symbol}` : ''}`]) : null,
        ])
      )
    )
  );
}
