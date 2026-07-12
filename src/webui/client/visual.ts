/**
 * Semantic styling for the AppGraph layer. Colors and line styles are FIXED
 * per kind/edge-kind (not insertion-order-derived like graph-view's old
 * categoryColor) so the legend is stable and a "red edge" always means the
 * same relationship. Node colors are chosen to read as their role:
 *   modules = architecture (orange), capabilities = the cross-platform
 *   anchors (green), permissions = restriction (red), screens = UX (blue)…
 */

import type { AppEdgeWire, AppNodeWire } from '../wire-types';
import type { LedgerStatusWire } from '../wire-types';
import type { AppGraphModel } from './appgraph-model';

export interface NodeStyle {
  color: string;
  /** Short glyph/emoji-free label for legend + tooltips. */
  label: string;
}

export const APP_NODE_STYLES: Record<string, NodeStyle> = {
  AppEntry: { color: '#8b5cf6', label: 'Entry' },
  Screen: { color: '#2f6fed', label: 'Screen' },
  BackgroundComponent: { color: '#64707d', label: 'Service/Worker' },
  Permission: { color: '#e0524f', label: 'Permission' },
  Capability: { color: '#4caf7d', label: 'Capability' },
  ArchModule: { color: '#e0954f', label: 'Module' },
  Resource: { color: '#4fb6e0', label: 'Resource' },
  DataModel: { color: '#b8a13a', label: 'Data Model' },
  Feature: { color: '#c25be0', label: 'Feature' },
};

export function nodeColor(kind: string): string {
  return APP_NODE_STYLES[kind]?.color ?? '#8c8c8c';
}

export interface EdgeStyle {
  color: string;
  label: string;
  /** 'solid' | 'dashed' | 'dotted' — used by the legend swatch. */
  dash: 'solid' | 'dashed' | 'dotted';
  /** One-line description for the legend / tooltip. */
  description: string;
}

export const APP_EDGE_STYLES: Record<string, EdgeStyle> = {
  app_contains: { color: '#94a3b8', label: 'contains', dash: 'solid', description: 'Module/feature contains a node' },
  navigates_to: { color: '#2f6fed', label: 'navigates to', dash: 'solid', description: 'Screen → Screen page transition' },
  requires_permission: { color: '#e0524f', label: 'requires permission', dash: 'dashed', description: 'Screen/component needs a permission' },
  uses_capability: { color: '#4caf7d', label: 'uses capability', dash: 'dashed', description: 'Cross-platform capability link' },
  exposes: { color: '#8b5cf6', label: 'exposes', dash: 'solid', description: 'Entry exposes a resource (deep link, …)' },
  depends_on: { color: '#e0954f', label: 'depends on', dash: 'solid', description: 'Module/feature dependency' },
  backed_by: { color: '#64707d', label: 'backed by', dash: 'dotted', description: 'Screen backed by a background component' },
  maps_to: { color: '#c25be0', label: 'maps to', dash: 'dotted', description: 'Cross-graph source↔target mapping' },
};

export function edgeStyle(kind: string): EdgeStyle {
  return APP_EDGE_STYLES[kind] ?? { color: '#94a3b8', label: kind, dash: 'solid', description: kind };
}

/** A `depends_on` edge's trust flag: declared (conf 1) vs lifted vs suspect. */
export function dependsOnFlag(e: AppEdgeWire): { label: string; tone: 'declared' | 'lifted' | 'suspect' } | null {
  if (e.kind !== 'depends_on') return null;
  const suspect = e.attrs?.suspect;
  if (typeof suspect === 'string') return { label: suspect, tone: 'suspect' };
  if (e.provenance === 'manifest' || e.provenance === 'source-static' || e.confidence >= 1) {
    return { label: 'declared', tone: 'declared' };
  }
  return { label: 'lifted', tone: 'lifted' };
}

/** Node size for the canvas: modules by symbol count, features by size,
 *  screens by degree, else a small fixed size. Keeps the visually important
 *  nodes prominent without an explicit "importance" field. */
export function nodeSize(node: AppNodeWire, model: AppGraphModel): number {
  switch (node.kind) {
    case 'ArchModule': {
      const sc = typeof node.attrs?.symbolCount === 'number' ? node.attrs.symbolCount : 0;
      return 4 + Math.min(14, Math.sqrt(sc));
    }
    case 'Feature': {
      const size = typeof node.attrs?.size === 'number' ? node.attrs.size : 1;
      return 4 + Math.min(10, Math.sqrt(size));
    }
    case 'Screen':
    case 'AppEntry': {
      const deg = (model.outByNode.get(node.id) ?? []).length + (model.inByNode.get(node.id) ?? []).length;
      return 4 + Math.min(8, deg);
    }
    default:
      return 4;
  }
}

/** Provenance → 0..1 trust score for the meter. Manifest facts are most
 *  trustworthy; llm overlay is advisory. */
export function provenanceTrust(provenance: string): number {
  switch (provenance) {
    case 'manifest':
      return 1;
    case 'source-static':
      return 0.9;
    case 'lifted':
      return 0.6;
    case 'llm':
      return 0.3;
    default:
      return 0.5;
  }
}

/** A short human label for a provenance tier. */
export function provenanceLabel(provenance: string): string {
  switch (provenance) {
    case 'manifest':
      return 'Manifest';
    case 'source-static':
      return 'Source';
    case 'lifted':
      return 'Lifted'
    case 'llm':
      return 'LLM';
    default:
      return provenance;
  }
}

/** Maps a Feature role to a short tag + tone for chips. */
export function featureRoleTone(role: string): { label: string; tone: string } {
  switch (role) {
    case 'subdivision':
      return { label: 'Subdivision', tone: 'warn' };
    case 'cross-module':
      return { label: 'Cross-module', tone: 'info' };
    case 'aligned':
    default:
      return { label: 'Aligned', tone: 'ok' };
  }
}

// =============================================================================
// Migration status styling
// =============================================================================

export const MIGRATION_STATUS_STYLES: Record<LedgerStatusWire, { color: string; label: string; tone: string }> = {
  pending: { color: '#9aa4af', label: 'Pending', tone: '' },
  'in-progress': { color: '#2f6fed', label: 'In Progress', tone: 'info' },
  migrated: { color: '#b8a13a', label: 'Migrated', tone: 'warn' },
  verified: { color: '#4caf7d', label: 'Verified', tone: 'ok' },
  blocked: { color: '#c53030', label: 'Blocked', tone: 'danger' },
};

export function migrationStatusColor(status: LedgerStatusWire): string {
  return MIGRATION_STATUS_STYLES[status].color;
}

export function migrationStatusLabel(status: LedgerStatusWire): string {
  return MIGRATION_STATUS_STYLES[status].label;
}

export function migrationStatusTone(status: LedgerStatusWire): string {
  return MIGRATION_STATUS_STYLES[status].tone;
}
