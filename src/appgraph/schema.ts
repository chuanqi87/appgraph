/**
 * AppGraph — platform-neutral application knowledge graph.
 *
 * This layer is deliberately SEPARATE from CodeGraph's code-symbol graph
 * (`src/types.ts`). CodeGraph nodes are code symbols (bound to file/line/
 * language); AppGraph nodes are migration-relevant *capabilities* of an app
 * (screens, permissions, platform-neutral capabilities, components, …) that a
 * permission or a deep link — which are not code symbols — can inhabit.
 *
 * The code graph is only scaffolding for "lifting" high-level edges; the
 * AppGraph is the deliverable and the unit of cross-platform comparison.
 *
 * Determinism boundary (the foundation of the whole design):
 *   - Structural nodes (Screen, BackgroundComponent, Permission, Capability,
 *     ArchModule, Resource) are extracted DETERMINISTICALLY and carry a stable
 *     `matchKey` — they are the migration ground truth and the comparison
 *     identity.
 *   - `Feature` is an LLM-labelled overlay (advisory). Its human-readable name
 *     MUST NOT participate in `matchKey` / cross-platform matching.
 */

import { createHash } from 'node:crypto';
import { CapabilityId } from './capabilities';

export type AppPlatform = 'android' | 'harmony' | 'ios';

/** How a node/edge entered the graph — cheapest (most trustworthy) first. */
export type Provenance =
  | 'manifest' // parsed verbatim from a declaration file (AndroidManifest.xml, module.json5)
  | 'source-static' // parsed deterministically from source (tree-sitter)
  | 'lifted' // derived by walking the code graph (heuristic, evidence-backed)
  | 'llm'; // semantic overlay (advisory, never a comparison identity)

/** What the graph was extracted from — coarse confidence context. */
export type Fidelity = 'source-project' | 'binary' | 'partial';

export const APP_NODE_KINDS = [
  'AppEntry', // launcher / entry point
  'Screen', // a page/view (activity, fragment, compose destination, arkts page)
  'BackgroundComponent', // service, worker, receiver, provider, ability
  'Permission', // raw, platform-specific permission (kept for provenance)
  'Capability', // platform-neutral capability — the cross-platform match anchor
  'ArchModule', // build/HAP module, tagged with an architecture role
  'Resource', // externally addressable surface (deep link, url scheme, shortcut)
  'DataModel', // a persistable/serializable data model + its field schema (migration first-class)
  'Feature', // LLM-labelled functional cluster (advisory)
] as const;
export type AppNodeKind = (typeof APP_NODE_KINDS)[number];

export const APP_EDGE_KINDS = [
  'app_contains', // Feature→Screen, ArchModule→Screen
  'navigates_to', // Screen→Screen
  'requires_permission', // Screen/Component→Permission
  'uses_capability', // Screen/Component→Capability
  'exposes', // AppEntry→Resource
  'depends_on', // Feature→Feature, ArchModule→ArchModule
  'backed_by', // Screen→BackgroundComponent
  'maps_to', // cross-graph source↔target (produced by the diff stage)
] as const;
export type AppEdgeKind = (typeof APP_EDGE_KINDS)[number];

/** Points back at where a node/edge was observed, for auditability. */
export interface PlatformRef {
  /** Project-relative file path. */
  file: string;
  /** Platform symbol (fully-qualified class name, permission string, …). */
  symbol?: string;
}

export interface AppNode {
  /** Stable, content-derived id (see `makeNodeId`). */
  id: string;
  kind: AppNodeKind;
  /**
   * Deterministic canonical key used for cross-platform matching.
   * For `Capability` this is the controlled-vocabulary id (fully cross-platform).
   * For `Screen`/`Feature` it is platform-scoped only (never matched 1:1).
   */
  matchKey: string;
  name: string;
  platform: AppPlatform;
  subtype?: string;
  platformRef?: PlatformRef;
  provenance: Provenance;
  fidelity: Fidelity;
  /** 0–1. Manifest facts are 1; lifted/llm edges are lower. */
  confidence: number;
  attrs?: Record<string, unknown>;
}

export interface AppEdge {
  id: string;
  kind: AppEdgeKind;
  from: string;
  to: string;
  provenance: Provenance;
  confidence: number;
  attrs?: Record<string, unknown>;
}

/** A place where extraction could not fully recover the truth — surfaced, never dropped silently. */
export interface CoverageWarning {
  message: string;
  ref?: PlatformRef;
}

export const APP_GRAPH_SCHEMA_VERSION = 1;

export interface AppGraph {
  schemaVersion: number;
  platform: AppPlatform;
  app: { name: string; packageName: string };
  fidelity: Fidelity;
  /** Node kinds this extractor is able to emit (honesty about coverage). */
  supportedKinds: AppNodeKind[];
  nodes: AppNode[];
  edges: AppEdge[];
  coverageWarnings: CoverageWarning[];
}

// =============================================================================
// matchKey / id helpers — the determinism primitives
// =============================================================================

/** Lowercase, strip non-alphanumerics — stable slug for names/keys. */
export function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function capabilityMatchKey(id: CapabilityId): string {
  return `capability:${id}`;
}

/** Normalize a permission string to its short, platform-neutral-ish tail. */
export function permissionMatchKey(permission: string): string {
  const tail = permission.split('.').pop() ?? permission;
  return `permission:${slug(tail)}`;
}

/**
 * Screen match keys are PLATFORM-SCOPED only. The simple class/page name is the
 * stable within-platform identity; cross-platform screens are aligned via
 * capability sets + Feature membership, never by this key.
 */
export function screenMatchKey(simpleName: string): string {
  return `screen:${slug(simpleName)}`;
}

export function componentMatchKey(simpleName: string): string {
  return `component:${slug(simpleName)}`;
}

/**
 * DataModel match keys are PLATFORM-SCOPED (like Screen): the simple model name
 * is the stable within-platform identity. Cross-platform entity alignment is done
 * by name + field schema in the diff, never by this key 1:1.
 */
export function dataModelMatchKey(simpleName: string): string {
  return `datamodel:${slug(simpleName)}`;
}

export function resourceMatchKey(scheme: string, host?: string): string {
  return host ? `resource:${slug(scheme)}:${slug(host)}` : `resource:${slug(scheme)}`;
}

/**
 * Content-derived node id: stable across runs for the same logical node, so
 * re-extraction and diffing are deterministic. Deliberately excludes volatile
 * fields (line numbers, timestamps).
 */
export function makeNodeId(platform: AppPlatform, kind: AppNodeKind, matchKey: string): string {
  return createHash('sha1').update(`${platform}\0${kind}\0${matchKey}`).digest('hex').slice(0, 16);
}

export function makeEdgeId(kind: AppEdgeKind, from: string, to: string): string {
  return createHash('sha1').update(`${kind}\0${from}\0${to}`).digest('hex').slice(0, 16);
}
