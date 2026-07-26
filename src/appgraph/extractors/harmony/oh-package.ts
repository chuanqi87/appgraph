/**
 * `oh-package.json5` — the ohpm manifest, and the ONLY source of module→module
 * dependency edges in a HarmonyOS project.
 *
 * `build-profile.json5` declares that a module EXISTS; it says nothing about who
 * depends on whom. That lives here, as `"<bare-name>": "file:<relative-path>"`,
 * where the key is literally the specifier used in `import … from '<bare-name>'`.
 *
 *   { "name": "entry", "main": "",
 *     "dependencies": { "lib_foundation": "file:../../commons/lib_foundation" } }
 *
 * The `main` field also discriminates the module kind: HAPs leave it empty, while
 * HAR/HSP point it at the `Index.ets` barrel that defines their public surface.
 */

import { asObject, asString, readJson5, type Json5Issue } from './json5';

/** One `file:` dependency: the import name plus the path it resolves to. */
export interface OhPackageDep {
  /** Bare specifier used in `import … from '<name>'`. */
  name: string;
  /** Dependency path as written, relative to the declaring module's dir. */
  rawTarget: string;
}

export interface OhPackage {
  /** Declared package name (often, but not always, the build-profile module name). */
  name?: string;
  /** Entry barrel: `Index.ets` for HAR/HSP, empty/absent for HAP. */
  main?: string;
  /** `"InterfaceHar"` marks an HSP's interface package. */
  packageType?: string;
  deps: OhPackageDep[];
  issues: Json5Issue[];
}

const EMPTY: OhPackage = { deps: [], issues: [] };

/** Parse a module's `oh-package.json5`. Missing file → empty, no issue. */
export function readOhPackage(absPath: string): OhPackage {
  const { value, issues } = readJson5(absPath);
  const obj = asObject(value);
  if (!obj) {
    // A read failure is not an extraction gap when the file simply isn't there;
    // the caller decides whether a module is *expected* to have one.
    return issues.some((i) => i.kind === 'read') ? EMPTY : { ...EMPTY, issues };
  }

  const deps: OhPackageDep[] = [];
  const depsObj = asObject(obj.dependencies);
  if (depsObj) {
    for (const [name, raw] of Object.entries(depsObj)) {
      const spec = asString(raw);
      if (!spec || !spec.startsWith('file:')) continue; // registry dep, not a local module
      const rawTarget = spec.slice('file:'.length).trim();
      if (rawTarget) deps.push({ name, rawTarget });
    }
  }
  deps.sort((a, b) => a.name.localeCompare(b.name));

  return {
    name: asString(obj.name),
    main: asString(obj.main),
    packageType: asString(obj.packageType),
    deps,
    issues,
  };
}
