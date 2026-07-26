/**
 * M1 · HarmonyOS module skeleton — the DECLARED half of the module graph.
 *
 * The Gradle analogue is `gradle-ext.ts`; this produces the identical
 * `ModuleSkeleton` contract from hvigor's two-file split:
 *   - root `build-profile.json5` `modules[]`  → which modules exist (≈ settings.gradle)
 *   - module `oh-package.json5` `dependencies` → who depends on whom (≈ implementation project(...))
 *
 * That split is why both files must be read: neither alone yields the graph.
 *
 * Module ROLE comes from two independent signals that the corpus shows are
 * near-universal — the four-directory convention (`products/` `features/`
 * `components/` `commons/`) and `module.json5`'s `type` (`entry` `har` `shared`) —
 * so a module keeps a sensible role even when a project deviates from the layout.
 */

import { CoverageWarning, AppEdge, AppNode, makeEdgeId, makeNodeId, slug } from '../schema';
import type { ModuleSkeleton } from './gradle-ext';
import {
  HarmonyModule,
  HarmonyProject,
  loadHarmonyProject,
  normalizeModuleDir,
} from '../extractors/harmony/project';

/** Walk the project and assemble the declared module graph. */
export function extractHarmonyModuleSkeleton(projectRoot: string): ModuleSkeleton {
  const project = loadHarmonyProject(projectRoot);
  if (!project) {
    return {
      packageName: null,
      nodes: [],
      edges: [],
      warnings: [
        {
          message:
            `未找到 AppScope/app.json5——该目录不是 HarmonyOS 工程根,应用图为空。` +
            `若这是混合工程(如 Flutter),请把鸿蒙子目录(通常是 ohos/)作为工程根传入`,
        },
      ],
      moduleDirToId: new Map(),
      moduleDirs: [],
    };
  }
  return buildHarmonyModuleGraph(project);
}

/** Assemble ArchModule nodes + depends_on edges from the loaded project model. */
export function buildHarmonyModuleGraph(project: HarmonyProject): ModuleSkeleton {
  const nodes: AppNode[] = [];
  const edges: AppEdge[] = [];
  const warnings: CoverageWarning[] = [...project.warnings];
  const moduleDirToId = new Map<string, string>();
  const idByDir = new Map<string, string>();
  /** Bare import name (the oh-package dependency key) → module id. */
  const idByDepName = new Map<string, string>();

  for (const mod of project.modules) {
    const matchKey = `module:${slug(mod.name)}`;
    const id = makeNodeId('harmony', 'ArchModule', matchKey);
    const { role, layer, necessity } = classifyHarmonyModule(mod);

    nodes.push({
      id,
      kind: 'ArchModule',
      matchKey,
      name: mod.name,
      platform: 'harmony',
      subtype: role,
      platformRef: { file: `${mod.dir}/src/main/module.json5`, symbol: mod.name },
      provenance: 'manifest',
      fidelity: 'source-project',
      confidence: 1,
      attrs: {
        dir: mod.dir,
        role,
        layer,
        necessity,
        // `har` (static, copied per consumer) vs `shared` (HSP, one instance per
        // process) changes singleton/global-state semantics — worth carrying.
        moduleType: mod.type,
        ...(mod.manifest?.deviceTypes.length ? { deviceTypes: mod.manifest.deviceTypes } : {}),
        ...(mod.appliesToProducts.length ? { products: mod.appliesToProducts } : {}),
        ...(mod.ohPackage?.main ? { entryFile: mod.ohPackage.main } : {}),
        ...(mod.ohPackage?.packageType ? { packageType: mod.ohPackage.packageType } : {}),
      },
    });

    moduleDirToId.set(mod.dir, id);
    idByDir.set(mod.dir, id);
    // Both the build-profile name and the ohpm package name can appear as an
    // import specifier; register both so a dependency resolves either way.
    idByDepName.set(mod.name, id);
    if (mod.ohPackage?.name) idByDepName.set(mod.ohPackage.name, id);
  }

  for (const mod of project.modules) {
    const fromId = idByDir.get(mod.dir);
    if (!fromId || !mod.ohPackage) continue;

    for (const dep of mod.ohPackage.deps) {
      // Resolve by PATH first — it is unambiguous; the bare name is the fallback
      // for a dependency whose key differs from its directory.
      const targetDir = resolveRelativeModuleDir(mod.dir, dep.rawTarget);
      const toId = idByDir.get(targetDir) ?? idByDepName.get(dep.name);
      if (!toId) {
        warnings.push({
          message:
            `模块 ${mod.name} 依赖的 ${dep.name}(file:${dep.rawTarget}) 未在工程模块清单中找到,` +
            `depends_on 边未生成`,
          ref: { file: `${mod.dir}/oh-package.json5`, symbol: dep.name },
        });
        continue;
      }
      if (toId === fromId) continue; // self-reference — never an edge

      edges.push({
        id: makeEdgeId('depends_on', fromId, toId),
        kind: 'depends_on',
        from: fromId,
        to: toId,
        provenance: 'manifest',
        confidence: 1,
        attrs: { importName: dep.name },
      });
    }
  }

  // Deduplicate: two dependency keys can point at the same module.
  const uniqueEdges = [...new Map(edges.map((e) => [e.id, e])).values()].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)
  );

  const moduleDirs = project.modules.map((m) => m.dir).sort();
  return {
    packageName: project.bundleName,
    nodes,
    edges: uniqueEdges,
    warnings,
    moduleDirToId,
    moduleDirs,
  };
}

/**
 * Resolve an oh-package `file:` target against the declaring module's dir.
 * `features/order` + `../../commons/foundation` → `commons/foundation`.
 */
export function resolveRelativeModuleDir(fromDir: string, rawTarget: string): string {
  const segments = fromDir ? fromDir.split('/') : [];
  for (const part of normalizeModuleDir(rawTarget).split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  return segments.join('/');
}

/**
 * Architecture role + layer + necessity.
 *
 * The four-directory convention is the primary signal (near-universal in the
 * corpus); `module.json5`'s `type` refines it and covers projects that deviate.
 */
export function classifyHarmonyModule(mod: HarmonyModule): {
  role: string;
  layer: string | null;
  necessity: 'product' | 'dev-only';
} {
  const top = mod.dir.split('/')[0] ?? '';
  const tokens = new Set(tokenize(`${mod.dir}/${mod.name}`));
  const has = (...words: string[]): boolean => words.some((w) => tokens.has(w));

  // Test-support modules are never on the migration critical path.
  if (has('test', 'tests', 'mock', 'mocks', 'ohostest')) {
    return { role: 'test-support', layer: null, necessity: 'dev-only' };
  }

  let role: string;
  if (mod.type === 'entry' || mod.type === 'feature' || top === 'products') role = 'app';
  else if (top === 'features' || top === 'feature') role = 'feature';
  else if (top === 'commons' || top === 'common') role = 'core';
  else if (top === 'components' || top === 'component') role = 'component';
  else role = 'library';

  let layer: string | null = null;
  if (has('ui', 'widget', 'widgets', 'component', 'components', 'view', 'views')) layer = 'ui';
  else if (has('network', 'net', 'api', 'apis', 'data', 'database', 'storage', 'http')) {
    layer = 'data';
  } else if (has('domain', 'business', 'service', 'services')) layer = 'domain';
  else if (has('model', 'models', 'entity', 'bean')) layer = 'model';
  else if (has('common', 'commons', 'util', 'utils', 'foundation', 'base', 'core')) layer = 'common';

  return { role, layer, necessity: 'product' };
}

/**
 * Split a module path/name into lowercase words.
 *
 * HarmonyOS module names are overwhelmingly snake_case (`lib_foundation`,
 * `module_base_apis`, `business_home`), so `_` must be a separator — a `\bword\b`
 * regex treats `_` as a word character and would never match `test` in
 * `test_utils`.
 */
function tokenize(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
