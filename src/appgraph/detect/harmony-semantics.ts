/**
 * U · HarmonyOS semantic enrichment — orchestration.
 *
 * The Android analogue is `semantics.ts`. It returns the same `SemanticsResult`
 * so `buildAppGraph` stays platform-neutral; the passes behind it differ
 * entirely (ArkUI/Navigation vs. Compose/Jetpack).
 *
 * Passes land phase by phase. Whatever is not wired yet is simply absent from
 * the graph AND absent from the producer's `supportedKinds`, so a consumer can
 * tell "not extracted" from "not present" — never a silent zero.
 */

import { AppEdge, AppNode, CoverageWarning } from '../schema';
import type { SemanticsResult } from './semantics';
import type { SemanticsInput } from '../platforms/types';
import type { ModuleRef } from './manifest-capabilities';
import type { Node } from '../../types';
import type { CodeSymbolGraph } from '../graph-reader';
import type { ReadCode } from './shared';
import { loadHarmonyProject } from '../extractors/harmony/project';
import { buildRouteRegistry } from '../extractors/harmony/route-map';
import { harmonyCapabilityNode } from '../extractors/harmony/surface';
import { harmonyTargetFor } from './api-capabilities';
import { detectHarmonyStructure } from './harmony-structure';
import { detectHarmonyPages } from './harmony-pages';
import { liftHarmonyNavigation } from './harmony-navigation';
import { detectHarmonyState } from './harmony-state';

/** A `SemanticsResult` with every counter zeroed — the base every phase adds to. */
export function emptySemanticsResult(): SemanticsResult {
  return {
    nodes: [],
    edges: [],
    warnings: [],
    navFrameworks: [],
    roles: { byNodeId: new Map(), byQName: new Map() },
    stats: {
      rolesTagged: 0,
      screens: 0,
      navEdges: 0,
      dataModels: 0,
      diModules: 0,
      diWiredEdges: 0,
      exposedStates: 0,
      sqldelightTables: 0,
      sqliteHintModules: 0,
      resourceFiles: 0,
      layoutScreens: 0,
      activityScreens: 0,
      backgroundComponents: 0,
      appEntries: 0,
      deeplinks: 0,
      intentNavEdges: 0,
      backedByEdges: 0,
      layoutLinks: 0,
      navGraphXmlEdges: 0,
      navGraphXmlScreens: 0,
      navFrameworks: 0,
      constantLiterals: 0,
      constantRoutes: 0,
      constantQueries: 0,
      constantEnums: 0,
      testClasses: 0,
      testCases: 0,
      warnings: 0,
    },
  };
}

/**
 * Build the HarmonyOS semantic augmentation.
 *
 * Structural facts (AppEntry / BackgroundComponent / Permission / Resource) come
 * from `module.json5` and are produced by the manifest stage, not here.
 */
export function buildHarmonySemantics(input: SemanticsInput): SemanticsResult {
  const result = emptySemanticsResult();
  const nodes: AppNode[] = [];
  const edges: AppEdge[] = [];
  const warnings: CoverageWarning[] = [];

  const project = loadHarmonyProject(input.root);
  if (project) {
    const modules = moduleRefs(input.archModules);
    // One source cache across every pass — each span is read at most once.
    const readCode = memoizeCode(input.reader);

    // S2 · manifest structure: entries, background components, deep links.
    const structure = detectHarmonyStructure(project, modules);
    nodes.push(...structure.nodes);
    edges.push(...structure.edges);
    warnings.push(...structure.warnings);
    result.stats.appEntries = structure.stats.appEntries;
    result.stats.backgroundComponents = structure.stats.backgroundComponents;
    result.stats.deeplinks = structure.stats.deeplinks;

    // S3 · route registry → Screen (three sources, merged).
    const registry = buildRouteRegistry(project);
    warnings.push(...registry.warnings);

    const pages = detectHarmonyPages(input.reader, readCode, registry, modules);
    nodes.push(...pages.screenNodes);
    edges.push(...pages.containsEdges);
    warnings.push(...pages.warnings);
    result.stats.screens = pages.stats.screens;

    // ArkUI declarative UI is decorator-declared, never imported, so the
    // import-driven capability pass cannot see it unless the project happens to
    // import `@kit.ArkUI` (which maps to the same id). Emit it from the
    // component structs instead — carrying the SAME target attrs M3 would have
    // attached, because node merge is last-write-wins by id and a bare node
    // would otherwise strip the `constructs` / `harmonyModule` fields that make
    // a Capability actionable downstream.
    if (pages.hasComponents) nodes.push(enrichedUiCapability());

    // U3 · DataModel — AppStorageV2/PersistenceV2 global state models.
    const state = detectHarmonyState(input.reader, readCode, modules);
    nodes.push(...state.dataModelNodes);
    edges.push(...state.containsEdges);
    warnings.push(...state.warnings);
    result.stats.dataModels = state.stats.dataModels;

    // A2 · navigation, lifted from the core graph's synthesized edges only.
    const nav = liftHarmonyNavigation(
      input.reader,
      pages.screenNodes,
      structure.nodes.filter((n) => n.kind === 'AppEntry'),
      registry
    );
    edges.push(...nav.navEdges);
    warnings.push(...nav.warnings);
    result.stats.navEdges = nav.stats.navigatesTo;
  }

  result.nodes = nodes;
  result.edges = edges;
  result.warnings = warnings;
  result.stats.warnings = warnings.length;
  return result;
}

/**
 * The `ui.declarative` Capability with its HarmonyOS target attached — shaped
 * exactly like the ones the API-import pass emits, so whichever writes last the
 * node carries the same information.
 */
function enrichedUiCapability(): AppNode {
  const node = harmonyCapabilityNode('ui.declarative');
  const target = harmonyTargetFor('ui.declarative');
  if (!target) return node;
  return {
    ...node,
    attrs: {
      ...node.attrs,
      harmonyModule: target.module,
      harmonyNote: target.note,
      constructs: target.constructs ?? [],
    },
  };
}

/** Wrap the reader in a per-node source cache so each span is read at most once. */
function memoizeCode(reader: CodeSymbolGraph): ReadCode {
  const cache = new Map<string, string | null>();
  return (node: Node): string | null => {
    const cached = cache.get(node.id);
    if (cached !== undefined) return cached;
    const code = reader.getCode(node);
    cache.set(node.id, code);
    return code;
  };
}

/** ArchModule nodes → the {id,name,dir} refs the attributors need. */
function moduleRefs(archModules: AppNode[]): ModuleRef[] {
  const refs: ModuleRef[] = [];
  for (const m of archModules) {
    const dir = typeof m.attrs?.dir === 'string' ? m.attrs.dir : undefined;
    if (dir !== undefined) refs.push({ id: m.id, name: m.name, dir });
  }
  return refs;
}
