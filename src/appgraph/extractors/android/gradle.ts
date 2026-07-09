/**
 * Deterministic Gradle → ArchModule extractor.
 *
 * Recovers the architecture layer the manifest can't express: the module graph
 * (`:core:network`, `:feature:foryou:impl`, …), each module's namespace, the
 * app's applicationId (modern AGP keeps the package here, not in the manifest),
 * and inter-module `depends_on` edges.
 *
 * Parsed with focused regexes (consistent with CodeGraph's config-file
 * approach) — Gradle Kotlin/Groovy DSL is declarative enough that this is
 * deterministic without a full parser.
 */

import { AppEdge, AppNode, CoverageWarning, makeEdgeId, makeNodeId, slug } from '../../schema';

/** Which build configuration declared a module dependency. `test` covers every
 *  test-only configuration (testImplementation/androidTestImplementation/
 *  kspTest/…) — a test-scoped dep is NOT a migration prerequisite and must not
 *  enter the topo order or a unit's dependency list as if it were. */
export type GradleDepScope = 'main' | 'test';

export interface GradleDependency {
  /** Gradle path, e.g. `:core:testing`. */
  path: string;
  scope: GradleDepScope;
}

export interface GradleModule {
  /** Gradle path, e.g. `:core:network`. */
  path: string;
  /** Directory relative to the project root, e.g. `core/network`. */
  dir: string;
  namespace: string | null;
  applicationId: string | null;
  /** Gradle module dependencies (raw, before resolution). */
  dependencyPaths: GradleDependency[];
}

export interface GradleExtraction {
  packageName: string | null;
  nodes: AppNode[];
  edges: AppEdge[];
  warnings: CoverageWarning[];
  /** Map from module dir → node id, so other passes can attach screens to modules. */
  moduleDirToId: Map<string, string>;
}

const NAMESPACE_RE = /\bnamespace\s*=?\s*["']([^"']+)["']/;
const APPLICATION_ID_RE = /\bapplicationId\s*=\s*["']([^"']+)["']/;
/** Configuration word (if any) + `project(":x")` — Kotlin `testImplementation(project(":x"))`
 *  and Groovy `testImplementation project(':x')` both put the configuration right before. */
const PROJECT_DEP_RE = /(?:(\w+)\s*\(?\s*)?project\(\s*["']:([^"']+)["']\s*\)/g;
/** Configuration word (if any) + type-safe accessor `projects.core.testing`. */
const PROJECTS_ACCESSOR_RE = /(?:(\w+)\s*\(\s*|(\w+)\s+)?projects\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)/g;

/** Any test-only configuration: testImplementation, androidTestApi, kspTest, testFixturesApi… */
function scopeOf(configuration: string | undefined): GradleDepScope {
  return configuration && /test/i.test(configuration) ? 'test' : 'main';
}

/** Parse one build.gradle(.kts) file into a module descriptor. */
export function parseGradleModule(dir: string, source: string): GradleModule {
  const namespace = NAMESPACE_RE.exec(source)?.[1] ?? null;
  const applicationId = APPLICATION_ID_RE.exec(source)?.[1] ?? null;

  // `main` wins when a path shows up under both scopes.
  const scopeByPath = new Map<string, GradleDepScope>();
  const add = (path: string, scope: GradleDepScope): void => {
    const prev = scopeByPath.get(path);
    if (prev === 'main') return;
    scopeByPath.set(path, prev === undefined ? scope : scope === 'main' ? 'main' : prev);
  };
  for (const m of source.matchAll(PROJECT_DEP_RE)) {
    if (m[2]) add(`:${m[2]}`, scopeOf(m[1]));
  }
  for (const m of source.matchAll(PROJECTS_ACCESSOR_RE)) {
    if (m[3]) add(`:${m[3].split('.').join(':')}`, scopeOf(m[1] ?? m[2]));
  }

  return {
    path: dirToGradlePath(dir),
    dir,
    namespace,
    applicationId,
    dependencyPaths: [...scopeByPath.entries()].map(([path, scope]) => ({ path, scope })),
  };
}

/**
 * Assemble ArchModule nodes + depends_on edges from parsed modules. Matching of
 * dependency paths is slug-based so type-safe accessors (`screenshotTesting`)
 * reconcile with kebab-case dirs (`screenshot-testing`).
 */
export function buildModuleGraph(modules: GradleModule[]): GradleExtraction {
  const nodes: AppNode[] = [];
  const edges: AppEdge[] = [];
  const warnings: CoverageWarning[] = [];
  const moduleDirToId = new Map<string, string>();
  const idBySlug = new Map<string, string>();

  for (const mod of modules) {
    const matchKey = `module:${slug(mod.path)}`;
    const id = makeNodeId('android', 'ArchModule', matchKey);
    const { role, layer } = classifyModule(mod);
    nodes.push({
      id,
      kind: 'ArchModule',
      matchKey,
      name: mod.path,
      platform: 'android',
      subtype: role,
      platformRef: { file: `${mod.dir}/build.gradle.kts` },
      provenance: 'manifest',
      fidelity: 'source-project',
      confidence: 1,
      attrs: { dir: mod.dir, namespace: mod.namespace, role, layer },
    });
    moduleDirToId.set(mod.dir, id);
    idBySlug.set(slug(mod.path), id);
  }

  for (const mod of modules) {
    const fromId = idBySlug.get(slug(mod.path));
    if (!fromId) continue;
    for (const dep of mod.dependencyPaths) {
      const toId = idBySlug.get(slug(dep.path));
      if (!toId) {
        warnings.push({
          message: `模块 ${mod.path} 依赖的 ${dep.path} 未在工程内找到对应模块，depends_on 边未生成`,
          ref: { file: `${mod.dir}/build.gradle.kts`, symbol: dep.path },
        });
        continue;
      }
      edges.push({
        id: makeEdgeId('depends_on', fromId, toId),
        kind: 'depends_on',
        from: fromId,
        to: toId,
        provenance: 'manifest',
        confidence: 1,
        // test-scoped deps stay in the graph (information is kept) but every
        // ordering/planning consumer filters on this scope.
        ...(dep.scope === 'test' ? { attrs: { scope: 'test' } } : {}),
      });
    }
  }

  const withAppId = modules.filter((m) => m.applicationId);
  const primary =
    withAppId.find((m) => /(?:^|:)(app|mobile)$/.test(m.path)) ?? withAppId[0] ?? null;
  const packageName = primary?.applicationId ?? null;

  return { packageName, nodes, edges, warnings, moduleDirToId };
}

/** `feature/foryou/impl` → `:feature:foryou:impl` (root dir → `:`). */
function dirToGradlePath(dir: string): string {
  if (!dir || dir === '.') return ':';
  return `:${dir.split('/').join(':')}`;
}

/** Heuristic architecture role + layer from the module path segments. */
function classifyModule(mod: GradleModule): { role: string; layer: string | null } {
  const segments = mod.path.replace(/^:/, '').split(':');
  const first = segments[0] ?? '';
  const joined = segments.join(' ');

  let role = 'library';
  if (mod.applicationId || /\b(app|mobile|tv|wear)\b/.test(joined)) role = 'app';
  else if (first === 'feature') role = 'feature';
  else if (first === 'core') role = 'core';

  let layer: string | null = null;
  if (/\b(ui|designsystem|design-system)\b/.test(joined)) layer = 'ui';
  else if (/\b(data|database|network|datastore)\b/.test(joined)) layer = 'data';
  else if (/\bdomain\b/.test(joined)) layer = 'domain';
  else if (/\bmodel\b/.test(joined)) layer = 'model';
  else if (/\b(common|util|utils)\b/.test(joined)) layer = 'common';
  if (segments[segments.length - 1] === 'api') layer = 'api';
  else if (segments[segments.length - 1] === 'impl') layer = 'impl';

  return { role, layer };
}
