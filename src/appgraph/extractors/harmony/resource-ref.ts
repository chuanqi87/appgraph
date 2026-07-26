/**
 * `$profile:` / `$string:` / `$media:` / `$color:` resource-reference resolution.
 *
 * HarmonyOS references resources from `module.json5` by symbolic name, and the
 * file lives under a QUALIFIER directory (`base`, `dark`, `zh_CN`, `en_US`, …).
 * `base` is the fallback every project defines, so it wins; the others exist for
 * localization/theming and would resolve to the same logical resource.
 *
 * This matters most for `routerMap: "$profile:route_map"`: the profile FILENAME
 * is not fixed. The corpus has `route_map.json` (364), `router_map.json` (105),
 * plus `route_map_mine.json`, `home_route_map.json`, `router_map_report.json`
 * and a dozen more. Hardcoding a filename silently loses those projects'
 * navigation, so the name must always come from the manifest field.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Qualifier directories, in resolution order — `base` is the universal fallback. */
const QUALIFIER_ORDER = ['base', 'dark', 'zh_CN', 'en_US', 'zh_TW', 'zh_HK'];

/** Parsed `$type:name` reference. */
export interface ResourceRef {
  type: string;
  name: string;
}

/** Parse `$profile:route_map` → `{type:'profile', name:'route_map'}`; null if not a ref. */
export function parseResourceRef(value: string | undefined): ResourceRef | null {
  if (!value) return null;
  const m = /^\$([a-z]+):(.+)$/.exec(value.trim());
  if (!m) return null;
  return { type: m[1]!, name: m[2]! };
}

/**
 * Resolve a resource reference to a project-relative posix path, or null.
 *
 * `moduleDir` is project-relative; the returned path is too, so it can be used
 * as a `platformRef.file` directly.
 */
export function resolveResourceRef(
  root: string,
  moduleDir: string,
  ref: ResourceRef,
  extension = '.json'
): string | null {
  for (const qualifier of QUALIFIER_ORDER) {
    const rel = `${moduleDir}/src/main/resources/${qualifier}/${ref.type}/${ref.name}${extension}`;
    if (existsSync(join(root, ...rel.split('/')))) return rel;
  }
  return null;
}
