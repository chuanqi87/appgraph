/**
 * HarmonyOS project model — root discovery and the module inventory.
 *
 * TWO rules learned from 76 real projects, both load-bearing:
 *
 * 1. The project root is marked by `AppScope/`, NOT by `build-profile.json5`.
 *    Five projects vendor their dependencies under `ohpm_custom_dependency/`,
 *    which carries a full `build-profile.json5` + `oh-package.json5` but no
 *    `AppScope/`. Rooting on the build file counts those modules twice
 *    (WebShortDrama: 32 modules → 64).
 *
 * 2. The root `build-profile.json5`'s `modules[].srcPath` is the AUTHORITATIVE
 *    module list — the analogue of `settings.gradle`'s `include(...)`. Walking
 *    the tree for `module.json5` instead picks up `src/ohosTest/` test modules
 *    (976 of them corpus-wide) and vendored copies.
 *
 * Root vs. module `build-profile.json5` are told apart by shape: the root has
 * `app` + `modules`; a module has `apiType` + `targets`.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, normalize, posix, sep } from 'node:path';
import { CoverageWarning } from '../../schema';
import { asArray, asObject, asString, readJson5, type Json5Issue } from './json5';
import { ModuleManifest, readModuleManifest } from './module-manifest';
import { OhPackage, readOhPackage } from './oh-package';

/** Directories that never contain first-party source. */
export const HARMONY_EXCLUDED_DIRS = new Set([
  'oh_modules',
  'build',
  '.preview',
  'node_modules',
  '.git',
  '.idea',
  '.hvigor',
  '.appgraph',
  '.codegraph',
  // Vendored dependency mirror — real modules, but copies (see rule 1 above).
  'ohpm_custom_dependency',
]);

export interface HarmonyModule {
  /** Module name from the root build-profile — the authoritative identity. */
  name: string;
  /** Project-relative posix dir (`./features/order` → `features/order`). */
  dir: string;
  /** `entry` | `har` | `shared` | `feature`; null when the manifest is missing. */
  type: string | null;
  manifest: ModuleManifest | null;
  ohPackage: OhPackage | null;
  /** Products this module is built into (root build-profile `targets[]`). */
  appliesToProducts: string[];
}

export interface HarmonyProject {
  root: string;
  /** `AppScope/app.json5` → `app.bundleName` ≈ Android applicationId. */
  bundleName: string | null;
  /** Atomic service (元服务): bundleName `com.atomicservice.*` or installationFree. */
  atomicService: boolean;
  modules: HarmonyModule[];
  warnings: CoverageWarning[];
}

/** `AppScope/app.json5` presence — the one reliable HarmonyOS root marker. */
export function isHarmonyProjectRoot(root: string): boolean {
  return existsSync(join(root, 'AppScope', 'app.json5'));
}

/**
 * Find HarmonyOS project roots at or just below `root`.
 *
 * The shallow descent handles hybrid repos (a Flutter project whose HarmonyOS
 * shell lives in `ohos/`). Depth is capped at 2 deliberately: deeper scanning
 * would start finding vendored copies again.
 */
export function findHarmonyProjectRoots(root: string, maxDepth = 2): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (isHarmonyProjectRoot(dir)) {
      found.push(dir); // a project root never nests inside another
      return;
    }
    if (depth >= maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || HARMONY_EXCLUDED_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      walk(join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return found.sort();
}

/** Load the project model, or null when `root` is not a HarmonyOS project. */
export function loadHarmonyProject(root: string): HarmonyProject | null {
  if (!isHarmonyProjectRoot(root)) return null;

  const warnings: CoverageWarning[] = [];
  const { bundleName, atomicService } = readAppScope(root, warnings);

  const profilePath = join(root, 'build-profile.json5');
  const { value, issues } = readJson5(profilePath);
  pushIssues(warnings, issues, 'build-profile.json5', '工程模块清单');

  const profile = asObject(value);
  const rawModules = profile ? asArray(profile.modules) : [];
  if (rawModules.length === 0) {
    warnings.push({
      message:
        `根 build-profile.json5 未声明任何 modules——模块清单为空,` +
        `应用图将不含任何模块与依赖边(工程结构不可依赖)`,
      ref: { file: 'build-profile.json5' },
    });
  }

  const modules: HarmonyModule[] = [];
  const seenDirs = new Set<string>();
  for (const raw of rawModules) {
    const obj = asObject(raw);
    if (!obj) continue;
    const name = asString(obj.name);
    const srcPath = asString(obj.srcPath);
    if (!name || !srcPath) {
      warnings.push({
        message: `根 build-profile.json5 中有 modules 条目缺少 name 或 srcPath,已跳过`,
        ref: { file: 'build-profile.json5', symbol: name ?? srcPath },
      });
      continue;
    }

    const dir = normalizeModuleDir(srcPath);
    if (seenDirs.has(dir)) continue; // duplicate declaration — first wins, silently
    seenDirs.add(dir);

    const absDir = join(root, ...dir.split('/'));
    if (!existsSync(absDir)) {
      warnings.push({
        message: `build-profile 声明的模块 ${name}(${dir}) 在工程内不存在,已跳过`,
        ref: { file: 'build-profile.json5', symbol: name },
      });
      continue;
    }

    const manifestPath = join(absDir, 'src', 'main', 'module.json5');
    const hasManifest = existsSync(manifestPath);
    const manifest = hasManifest ? readModuleManifest(manifestPath) : null;
    if (manifest) {
      pushIssues(warnings, manifest.issues, `${dir}/src/main/module.json5`, `模块 ${name} 的清单`);
    } else {
      warnings.push({
        message: `模块 ${name}(${dir}) 缺少 src/main/module.json5——无法确定模块类型/权限/路由表`,
        ref: { file: `${dir}/src/main/module.json5`, symbol: name },
      });
    }

    const ohPath = join(absDir, 'oh-package.json5');
    const ohPackage = existsSync(ohPath) ? readOhPackage(ohPath) : null;
    if (ohPackage) {
      pushIssues(
        warnings,
        ohPackage.issues,
        `${dir}/oh-package.json5`,
        `模块 ${name} 的依赖声明`
      );
    }

    modules.push({
      name,
      dir,
      type: manifest?.type ?? null,
      manifest,
      ohPackage,
      appliesToProducts: readAppliesToProducts(obj.targets),
    });
  }

  modules.sort((a, b) => a.dir.localeCompare(b.dir));
  return { root, bundleName, atomicService, modules, warnings };
}

/** `AppScope/app.json5` → bundleName + atomic-service flag. */
function readAppScope(
  root: string,
  warnings: CoverageWarning[]
): { bundleName: string | null; atomicService: boolean } {
  const rel = 'AppScope/app.json5';
  const { value, issues } = readJson5(join(root, 'AppScope', 'app.json5'));
  pushIssues(warnings, issues, rel, '应用元信息');

  const app = asObject(asObject(value)?.app);
  const bundleName = app ? (asString(app.bundleName) ?? null) : null;
  return {
    bundleName,
    // `com.atomicservice.*` is the reserved prefix for 元服务 / atomic services.
    atomicService: bundleName?.startsWith('com.atomicservice.') ?? false,
  };
}

function readAppliesToProducts(raw: unknown): string[] {
  const out = new Set<string>();
  for (const t of asArray(raw)) {
    const obj = asObject(t);
    if (!obj) continue;
    for (const p of asArray(obj.applyToProducts)) {
      const name = asString(p);
      if (name) out.add(name);
    }
  }
  return [...out].sort();
}

/** `./features/order` / `features\order` → `features/order` (project-relative posix). */
export function normalizeModuleDir(srcPath: string): string {
  const cleaned = normalize(srcPath).split(sep).join(posix.sep);
  return cleaned.replace(/^\.\//, '').replace(/\/+$/, '').replace(/^\/+/, '');
}

/** Turn parse issues into coverage warnings — the anti-silence contract. */
function pushIssues(
  warnings: CoverageWarning[],
  issues: Json5Issue[],
  file: string,
  what: string
): void {
  if (issues.length === 0) return;
  const detail = issues.slice(0, 2).map((i) => i.message).join('; ');
  warnings.push({
    message: `${file} 解析失败或仅部分恢复(${detail})——${what}可能不完整`,
    ref: { file },
  });
}
