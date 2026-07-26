/**
 * Screen recovery — three sources, merged.
 *
 * A HarmonyOS page is not one syntactic thing, so all three must be unioned or
 * the screen list silently under-reports:
 *
 *   1. ROUTE REGISTRY  — a `route_map.json` entry IS a page by declaration
 *                        (manifest-grade, confidence 1). Authoritative and the
 *                        only source that knows the route NAME.
 *   2. `@Entry` struct  — the legacy router entry page (281 corpus uses).
 *   3. `NavDestination` — a `@ComponentV2 struct` whose `build()` roots at
 *                        `NavDestination` (2,693 uses) — the mainstream page
 *                        shape, and the only signal separating a page from an
 *                        ordinary reusable component.
 *
 * A struct hit by several sources yields ONE Screen node with merged attrs;
 * `screenMatchKey` (the simple name) is the identity, which is also what makes
 * this agree node-for-node with the target-side projection in `surface.ts`.
 */

import { AppEdge, AppNode, CoverageWarning, makeEdgeId, makeNodeId } from '../schema';
import { Node } from '../../types';
import { CodeSymbolGraph } from '../graph-reader';
import {
  HARMONY_COMPONENT_DECORATORS,
  ambiguousScreenNames,
  harmonyScreenMatchKey,
} from '../extractors/harmony/surface';
import type { HarmonyRouteRegistry } from '../extractors/harmony/route-map';
import { isNavDestinationPage } from './arkts-source';
import type { ModuleRef } from './manifest-capabilities';
import type { ReadCode } from './shared';

export interface HarmonyPageResult {
  screenNodes: AppNode[];
  /** app_contains: ArchModule → Screen. */
  containsEdges: AppEdge[];
  warnings: CoverageWarning[];
  /**
   * Whether the project declares ANY ArkUI component struct — the evidence for
   * the `ui.declarative` capability. It cannot be inferred from imports (ArkUI
   * components are decorator-declared, not imported), so the target-side
   * projection derives it the same way; both must agree.
   */
  hasComponents: boolean;
  stats: {
    screens: number;
    fromRoute: number;
    fromEntry: number;
    fromNavDestination: number;
    routesWithoutStruct: number;
  };
}

export function detectHarmonyPages(
  reader: CodeSymbolGraph,
  readCode: ReadCode,
  registry: HarmonyRouteRegistry,
  modules: ModuleRef[]
): HarmonyPageResult {
  const nodes = reader.getAllNodes();
  const structsByFile = new Map<string, Node[]>();
  for (const n of nodes) {
    if (n.kind !== 'struct') continue;
    const bucket = structsByFile.get(n.filePath);
    if (bucket) bucket.push(n);
    else structsByFile.set(n.filePath, [n]);
  }

  const screens = new Map<string, AppNode>();
  const warnings: CoverageWarning[] = [];
  const sources = new Map<string, Set<string>>();
  let routesWithoutStruct = 0;

  // Page names reused across modules must be qualified — see harmonyScreenMatchKey.
  const ambiguous = ambiguousScreenNames(
    nodes.filter(
      (n) =>
        n.kind === 'struct' && (n.decorators ?? []).some((d) => HARMONY_COMPONENT_DECORATORS.has(d))
    )
  );

  const record = (
    struct: Node,
    source: 'route' | 'entry' | 'nav-destination',
    extra: Record<string, unknown> = {}
  ): AppNode => {
    const matchKey = harmonyScreenMatchKey(struct.name, struct.filePath, ambiguous);
    const id = makeNodeId('harmony', 'Screen', matchKey);
    const decorators = struct.decorators ?? [];
    const existing = screens.get(id);
    // One page can be registered under SEVERAL route names (a phone-number
    // screen reached as both `OldPhone` and `NewPhone`), so route names
    // accumulate — keeping only the last would silently drop live routes.
    if (typeof extra.route === 'string') {
      const prior = (existing?.attrs?.routes as string[] | undefined) ?? [];
      extra = { ...extra, routes: [...new Set([...prior, extra.route])].sort() };
    }
    const node: AppNode = {
      id,
      kind: 'Screen',
      matchKey,
      name: struct.name,
      platform: 'harmony',
      subtype: decorators.includes('Entry') ? 'entry-page' : 'nav-destination',
      platformRef: { file: struct.filePath, symbol: struct.name },
      // A route declaration is a manifest fact; a decorator/build() shape is
      // recovered from source. The stronger provenance wins on merge.
      provenance: source === 'route' ? 'manifest' : 'source-static',
      fidelity: 'source-project',
      confidence: source === 'route' ? 1 : 0.9,
      attrs: { ...existing?.attrs, file: struct.filePath, decorators, ...extra },
    };
    // Same struct, several sources (registered route + `@Entry` + NavDestination
    // shape): keep the strongest provenance, but carry the merged attrs. Since
    // the match key is file-qualified when ambiguous, `existing` always refers
    // to the SAME struct, so `platformRef` and `attrs.file` cannot disagree.
    screens.set(
      id,
      existing && existing.confidence > node.confidence
        ? { ...existing, attrs: node.attrs }
        : node
    );
    let set = sources.get(id);
    if (!set) {
      set = new Set();
      sources.set(id, set);
    }
    set.add(source);
    return screens.get(id)!;
  };

  // --- 1. Route registry (authoritative) ------------------------------------
  const routeIndex = buildRouteResolutionIndex(reader, nodes);
  for (const [name, route] of registry.byName) {
    const struct = resolveRouteStruct(routeIndex, structsByFile, route.pageFile, route.buildFunction);
    if (!struct) {
      routesWithoutStruct++;
      warnings.push({
        message:
          `路由 ${name} 注册了页面 ${route.pageFile}(buildFunction ${route.buildFunction}),` +
          `但在代码图中未找到对应的组件 struct——该页面无法定位实现`,
        ref: { file: route.sourceFile, symbol: name },
      });
      continue;
    }
    record(struct, 'route', { route: name, buildFunction: route.buildFunction });
  }

  // --- 2/3. Decorator + build()-shape discovery ------------------------------
  let hasComponents = false;
  for (const structs of structsByFile.values()) {
    for (const struct of structs) {
      const decorators = struct.decorators ?? [];
      if (!decorators.some((d) => HARMONY_COMPONENT_DECORATORS.has(d))) continue;
      hasComponents = true;

      if (decorators.includes('Entry')) {
        record(struct, 'entry');
        continue;
      }
      const code = readCode(struct);
      if (code !== null && isNavDestinationPage(code)) record(struct, 'nav-destination');
    }
  }

  // --- Module attribution ----------------------------------------------------
  const containsEdges: AppEdge[] = [];
  const sortedModules = [...modules].sort((a, b) => b.dir.length - a.dir.length);
  for (const screen of screens.values()) {
    const file = screen.platformRef?.file ?? '';
    const owner = sortedModules.find((m) => file === m.dir || file.startsWith(`${m.dir}/`));
    if (!owner) continue;
    containsEdges.push({
      id: makeEdgeId('app_contains', owner.id, screen.id),
      kind: 'app_contains',
      from: owner.id,
      to: screen.id,
      provenance: 'manifest',
      confidence: 1,
    });
  }

  const countBySource = (s: string): number =>
    [...sources.values()].filter((set) => set.has(s)).length;

  return {
    screenNodes: [...screens.values()].sort((a, b) => a.id.localeCompare(b.id)),
    containsEdges: containsEdges.sort((a, b) => a.id.localeCompare(b.id)),
    warnings,
    hasComponents,
    stats: {
      screens: screens.size,
      fromRoute: countBySource('route'),
      fromEntry: countBySource('entry'),
      fromNavDestination: countBySource('nav-destination'),
      routesWithoutStruct,
    },
  };
}

/**
 * Resolve a route's page struct, graph-anchored, with three fallbacks.
 *
 * The registry's `buildFunction` is the precise link — `@Builder function
 * buildOrderDetailPage() { OrderDetailPage() }` gives a real `calls` edge to the
 * struct, so no name guessing is needed. The fallbacks cover projects that
 * inline the page or name the builder unconventionally.
 */
function resolveRouteStruct(
  index: RouteResolutionIndex,
  structsByFile: Map<string, Node[]>,
  pageFile: string,
  buildFunction: string
): Node | null {
  const structs = structsByFile.get(pageFile) ?? [];
  if (structs.length === 0) return null;

  // 1) buildFunction → the struct it calls (exact, graph-anchored).
  if (buildFunction) {
    const builder = index.callableByFileAndName.get(`${pageFile}\0${buildFunction}`);
    if (builder) {
      const byId = new Map(structs.map((s) => [s.id, s]));
      for (const targetId of index.callTargetsBySource.get(builder.id) ?? []) {
        const target = byId.get(targetId);
        if (target) return target;
      }
    }
  }

  // 2) The file declares exactly one struct.
  if (structs.length === 1) return structs[0]!;

  // 3) The struct named after the file.
  const stem = pageFile.split('/').pop()!.replace(/\.ets$/, '');
  return structs.find((s) => s.name === stem) ?? null;
}

/**
 * Lookups the route→struct resolution needs, built ONCE.
 *
 * Previously each route re-ran `getAllNodes()` + `getAllEdges()`, i.e. two full
 * table scans per route: O(routes × graph). On a 44-module project (121 routes,
 * 25.8k nodes) that alone was 14.5s of a 15.7s build, invisible to functional
 * tests because the output was correct — just quadratically slow.
 */
interface RouteResolutionIndex {
  /** `${filePath}\0${name}` → the function/method node. */
  callableByFileAndName: Map<string, Node>;
  /** node id → ids it `calls`. */
  callTargetsBySource: Map<string, string[]>;
}

function buildRouteResolutionIndex(reader: CodeSymbolGraph, nodes: Node[]): RouteResolutionIndex {
  const callableByFileAndName = new Map<string, Node>();
  for (const n of nodes) {
    if (n.kind !== 'function' && n.kind !== 'method') continue;
    const key = `${n.filePath}\0${n.name}`;
    if (!callableByFileAndName.has(key)) callableByFileAndName.set(key, n);
  }

  const callTargetsBySource = new Map<string, string[]>();
  for (const e of reader.getAllEdges()) {
    if (e.kind !== 'calls') continue;
    const bucket = callTargetsBySource.get(e.source);
    if (bucket) bucket.push(e.target);
    else callTargetsBySource.set(e.source, [e.target]);
  }

  return { callableByFileAndName, callTargetsBySource };
}
