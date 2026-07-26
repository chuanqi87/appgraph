/**
 * Navigation route registry — the whole-project map from a route NAME to the
 * page that implements it.
 *
 * This is the single most important HarmonyOS-specific structure. In real
 * projects (`NavPathStack` 2,781 uses vs. legacy `router.pushUrl` 19) navigation
 * is `pushPathByName('OrderDetail')`: a bare string with no path in it. The
 * mapping to a file exists only in `route_map.json`:
 *
 *   { "name": "OrderDetail",
 *     "pageSourceFile": "src/main/ets/views/OrderDetailPage.ets",
 *     "buildFunction": "buildOrderDetailPage" }
 *
 * Note the three names all differ — the route name is NOT derivable from the
 * file or the struct. Without this registry a route string cannot be resolved
 * at all; with it, resolution is exact and any unknown name can be dropped
 * rather than guessed.
 *
 * Two structural facts drive the design:
 *   - Route declarations are DISTRIBUTED (478 of 1,146 modules declare a
 *     `routerMap`), and route names are GLOBAL — `pushPathByName` carries no
 *     module qualifier. So the registry is a whole-project merge.
 *   - The profile FILENAME varies wildly, so it is always read from
 *     `module.json5`'s `routerMap` field, never hardcoded.
 *
 * `route_map.json` files are standard JSON (measured: 0 parse failures across
 * the corpus), so they use `JSON.parse`, not the JSON5 reader.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CoverageWarning } from '../../schema';
import { HarmonyProject } from './project';
import { parseResourceRef, resolveResourceRef } from './resource-ref';

export interface HarmonyRoute {
  /** The global key `pushPathByName(...)` uses. */
  name: string;
  /** Project-relative posix path of the page file. */
  pageFile: string;
  /** The `@Builder` function that instantiates the page struct. */
  buildFunction: string;
  /** Directory of the module that declared this route. */
  moduleDir: string;
  /** Project-relative path of the route_map json (provenance). */
  sourceFile: string;
}

export interface HarmonyRouteRegistry {
  /** Route name → route. Cross-module duplicates are REMOVED, not disambiguated. */
  byName: ReadonlyMap<string, HarmonyRoute>;
  /** Route names declared by more than one module (dropped from `byName`). */
  duplicates: string[];
  warnings: CoverageWarning[];
  stats: {
    routeMapFiles: number;
    routes: number;
    duplicates: number;
    modulesWithRouterMap: number;
    legacyPages: number;
  };
}

/** Build the whole-project route registry. */
export function buildRouteRegistry(project: HarmonyProject): HarmonyRouteRegistry {
  const byName = new Map<string, HarmonyRoute>();
  const duplicates = new Set<string>();
  const warnings: CoverageWarning[] = [];
  let routeMapFiles = 0;
  let modulesWithRouterMap = 0;
  let legacyPages = 0;

  for (const mod of project.modules) {
    const manifest = mod.manifest;
    if (!manifest) continue;

    // --- Navigation routes (the mainstream path) ---------------------------
    const routerRef = parseResourceRef(manifest.routerMap);
    if (routerRef) {
      modulesWithRouterMap++;
      const rel = resolveResourceRef(project.root, mod.dir, routerRef);
      if (!rel) {
        warnings.push({
          message:
            `模块 ${mod.name} 声明了 routerMap ${manifest.routerMap} 但未找到对应的 profile 文件——` +
            `该模块注册的页面全部缺失,导航图不完整`,
          ref: { file: `${mod.dir}/src/main/module.json5`, symbol: manifest.routerMap },
        });
        continue;
      }

      const routes = readRouteMap(project.root, rel);
      if (routes === null) {
        warnings.push({
          message: `路由表 ${rel} 解析失败——模块 ${mod.name} 注册的页面缺失,导航图不完整`,
          ref: { file: rel },
        });
        continue;
      }

      routeMapFiles++;
      for (const entry of routes) {
        const route: HarmonyRoute = {
          name: entry.name,
          pageFile: `${mod.dir}/${entry.pageSourceFile}`,
          buildFunction: entry.buildFunction,
          moduleDir: mod.dir,
          sourceFile: rel,
        };
        const existing = byName.get(route.name);
        if (existing && existing.pageFile !== route.pageFile) {
          // Route names are a GLOBAL namespace. Two modules claiming one name is
          // genuinely ambiguous at the call site, so BOTH are dropped — picking
          // the first would send every caller to an arbitrary page.
          duplicates.add(route.name);
          byName.delete(route.name);
          warnings.push({
            message:
              `路由名 ${route.name} 被多个模块重复注册(${existing.moduleDir}、${route.moduleDir})——` +
              `调用点无法判定目标,两条注册均已丢弃`,
            ref: { file: rel, symbol: route.name },
          });
          continue;
        }
        if (!duplicates.has(route.name)) byName.set(route.name, route);
      }
    }

    // --- Legacy router pages (`main_pages.json`) ---------------------------
    const pagesRef = parseResourceRef(manifest.pages);
    if (pagesRef) {
      const rel = resolveResourceRef(project.root, mod.dir, pagesRef);
      const pages = rel ? readMainPages(project.root, rel) : null;
      // Counted, not indexed: legacy pages are recovered as Screens through
      // their `@Entry` decorator, so only the TALLY has a consumer — it tells a
      // legacy-router project apart from one with no navigation at all.
      if (pages) legacyPages += pages.length;
    }
  }

  return {
    byName,
    duplicates: [...duplicates].sort(),
    warnings,
    stats: {
      routeMapFiles,
      routes: byName.size,
      duplicates: duplicates.size,
      modulesWithRouterMap,
      legacyPages,
    },
  };
}

interface RawRoute {
  name: string;
  pageSourceFile: string;
  buildFunction: string;
}

/** Read a `route_map.json`. Returns null when unreadable/unparseable. */
function readRouteMap(root: string, rel: string): RawRoute[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(root, ...rel.split('/')), 'utf8'));
  } catch {
    return null;
  }
  const list = (parsed as { routerMap?: unknown })?.routerMap;
  if (!Array.isArray(list)) return null;

  const out: RawRoute[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name : '';
    const pageSourceFile = typeof e.pageSourceFile === 'string' ? e.pageSourceFile : '';
    const buildFunction = typeof e.buildFunction === 'string' ? e.buildFunction : '';
    if (name && pageSourceFile) out.push({ name, pageSourceFile, buildFunction });
  }
  return out;
}

/** Read a `main_pages.json` (`{"src":["pages/Index"]}`). */
function readMainPages(root: string, rel: string): string[] | null {
  try {
    const parsed = JSON.parse(readFileSync(join(root, ...rel.split('/')), 'utf8')) as {
      src?: unknown;
    };
    return Array.isArray(parsed.src) ? parsed.src.filter((s): s is string => typeof s === 'string') : null;
  } catch {
    return null;
  }
}
