/**
 * Unified color system for the semantic-zoom graph.
 *
 * Three levels each have their own coloring logic:
 *   Level 0 (Migration Units) → colored by migration status
 *   Level 1 (Modules) → colored by migration-unit membership (same unit = same color)
 *   Level 2 (Code Symbols) → colored by symbol kind
 *
 * Re-exports the AppGraph/Migration styling from visual.ts so the unified
 * graph has a single import point.
 */

import {
  APP_NODE_STYLES,
  MIGRATION_STATUS_STYLES,
  edgeStyle as appEdgeStyle,
  migrationStatusColor,
  nodeColor as appNodeColor,
} from './visual';
import type { LedgerStatusWire } from '../wire-types';

// -----------------------------------------------------------------------------
// Palette — used for unit-membership coloring at Level 1.
// Tableau-10-inspired, distinct enough for up to ~20 units.
// -----------------------------------------------------------------------------
export const PALETTE = [
  '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
  '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac',
  '#86bcb6', '#d37295', '#8cd17d', '#f1ce63', '#7f9ffe',
  '#c4a8ff', '#5cc8ff', '#ff8c42', '#a0e060', '#ff6b9d',
];

// -----------------------------------------------------------------------------
// Level 2 — CodeGraph symbol kind styling
// -----------------------------------------------------------------------------
export interface CgNodeStyle {
  color: string;
  label: string;
}

export const CG_NODE_STYLES: Record<string, CgNodeStyle> = {
  function: { color: '#4e79a7', label: 'Function' },
  method: { color: '#f28e2b', label: 'Method' },
  class: { color: '#59a14f', label: 'Class' },
  struct: { color: '#76b7b2', label: 'Struct' },
  interface: { color: '#b07aa1', label: 'Interface' },
  trait: { color: '#b07aa1', label: 'Trait' },
  protocol: { color: '#b07aa1', label: 'Protocol' },
  enum: { color: '#edc948', label: 'Enum' },
  enum_member: { color: '#ff9da7', label: 'Enum Member' },
  type_alias: { color: '#9c755f', label: 'Type Alias' },
  constant: { color: '#bab0ac', label: 'Constant' },
  variable: { color: '#d37295', label: 'Variable' },
  property: { color: '#86bcb6', label: 'Property' },
  field: { color: '#86bcb6', label: 'Field' },
  parameter: { color: '#8cd17d', label: 'Parameter' },
  namespace: { color: '#7f9ffe', label: 'Namespace' },
  module: { color: '#c4a8ff', label: 'Module' },
  import: { color: '#5cc8ff', label: 'Import' },
  export: { color: '#5cc8ff', label: 'Export' },
  route: { color: '#ff8c42', label: 'Route' },
  component: { color: '#a0e060', label: 'Component' },
};

export function cgNodeColor(kind: string): string {
  return CG_NODE_STYLES[kind]?.color ?? '#8c8c8c';
}

export function cgNodeLabel(kind: string): string {
  return CG_NODE_STYLES[kind]?.label ?? kind;
}

// -----------------------------------------------------------------------------
// Level 2 — CodeGraph edge kind styling
// -----------------------------------------------------------------------------
export const CG_EDGE_STYLES: Record<string, { color: string; label: string }> = {
  calls: { color: '#4e79a7', label: 'calls' },
  references: { color: '#76b7b2', label: 'references' },
  contains: { color: '#cfd3d8', label: 'contains' },
  imports: { color: '#5cc8ff', label: 'imports' },
  exports: { color: '#5cc8ff', label: 'exports' },
  extends: { color: '#b07aa1', label: 'extends' },
  implements: { color: '#b07aa1', label: 'implements' },
  overrides: { color: '#f28e2b', label: 'overrides' },
  instantiates: { color: '#59a14f', label: 'instantiates' },
  'type_of': { color: '#9c755f', label: 'type of' },
  returns: { color: '#8cd17d', label: 'returns' },
  decorates: { color: '#edc948', label: 'decorates' },
};

export function cgEdgeColor(kind: string): string {
  return CG_EDGE_STYLES[kind]?.color ?? '#cfd3d8';
}

// -----------------------------------------------------------------------------
// vis-network color object builders
// vis-network expects { background, border, highlight: { background, border } }
// -----------------------------------------------------------------------------

export interface VisColor {
  background: string;
  border: string;
  highlight: { background: string; border: string };
}

export function visColor(color: string, borderColor?: string): VisColor {
  const border = borderColor ?? color;
  return {
    background: color,
    border,
    highlight: { background: color, border: '#222' },
  };
}

// -----------------------------------------------------------------------------
// Unified color functions per level
// -----------------------------------------------------------------------------

/** Level 0: migration unit → color by status */
export function unitColor(status: LedgerStatusWire | 'unknown'): VisColor {
  const c = status === 'unknown' ? '#8c8c8c' : migrationStatusColor(status);
  return visColor(c);
}

/** Level 1: module → color by migration-unit membership (same unit = same palette color) */
export function moduleColorByUnit(unitIndex: number): VisColor {
  const c = PALETTE[unitIndex % PALETTE.length];
  return visColor(c);
}

/** Level 1: module → color by AppGraph node kind (fallback when no migration) */
export function moduleColorByKind(kind: string): VisColor {
  const c = appNodeColor(kind);
  return visColor(c);
}

/** Level 2: code symbol → color by symbol kind */
export function symbolColor(kind: string): VisColor {
  const c = cgNodeColor(kind);
  return visColor(c);
}

// Re-export AppGraph/Migration helpers for convenience
export { APP_NODE_STYLES, MIGRATION_STATUS_STYLES, appNodeColor, appEdgeStyle, migrationStatusColor };
