/**
 * M1 · module skeleton — the DECLARED half of the module dependency graph.
 *
 * Reuses appgraph's deterministic Gradle primitives (`parseGradleModule`,
 * `buildModuleGraph`, `classifyModule`) verbatim; this file only adds the two
 * things M1 needs on top:
 *   1. a focused walk that finds every module `build.gradle(.kts)` (the base
 *      appgraph walk isn't exported), and
 *   2. a `settings.gradle(.kts)` cross-check so a module that is declared in
 *      settings but has no reachable build file — or vice versa — surfaces as a
 *      coverage warning instead of silently shrinking the graph.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { AppEdge, AppNode, CoverageWarning, slug } from '../schema';
import {
  GradleExtraction,
  GradleModule,
  buildModuleGraph,
  parseGradleModule,
} from '../extractors/android/gradle';

const EXCLUDED_DIRS = new Set([
  'build',
  '.git',
  '.gradle',
  '.idea',
  'node_modules',
  '.appgraph',
  '.codegraph',
]);

// Top-level Gradle dirs that are build logic, not shippable app modules.
const NON_MODULE_DIRS = new Set(['buildSrc', 'build-logic']);

/** Result of the declared-side module extraction. */
export interface ModuleSkeleton {
  packageName: string | null;
  nodes: AppNode[];
  /** Declared `depends_on` edges (confidence 1, provenance 'manifest'). */
  edges: AppEdge[];
  warnings: CoverageWarning[];
  /** dir (project-relative, posix) → ArchModule node id. */
  moduleDirToId: Map<string, string>;
  /** All module dirs, sorted — the assignment pass matches file paths against these. */
  moduleDirs: string[];
}

/** Walk the project, parse every module build file, and assemble the module graph. */
export function extractModuleSkeleton(projectRoot: string): ModuleSkeleton {
  const gradleFiles = findModuleGradleFiles(projectRoot).sort();
  const modules: GradleModule[] = gradleFiles.map((abs) =>
    parseGradleModule(toPosix(relative(projectRoot, dirname(abs))), readFileSync(abs, 'utf8'))
  );

  const gradle: GradleExtraction = buildModuleGraph(modules);
  const warnings = [...gradle.warnings, ...crossCheckSettings(projectRoot, modules)];

  return {
    packageName: gradle.packageName,
    nodes: gradle.nodes,
    edges: gradle.edges,
    warnings,
    moduleDirToId: gradle.moduleDirToId,
    moduleDirs: modules.map((m) => m.dir).sort(),
  };
}

/** Every module-level `build.gradle(.kts)` (excludes root + build-logic + build output). */
function findModuleGradleFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip, never crash the whole extraction
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) walk(full);
      } else if (entry.name === 'build.gradle' || entry.name === 'build.gradle.kts') {
        if (isModuleGradleFile(full, root)) out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

function isModuleGradleFile(fullPath: string, root: string): boolean {
  const relDir = toPosix(relative(root, dirname(fullPath)));
  if (relDir === '' || relDir === '.') return false; // root project file
  const top = relDir.split('/')[0] ?? '';
  return !NON_MODULE_DIRS.has(top);
}

/**
 * Compare the modules discovered by the walk against the canonical `include(…)`
 * list in `settings.gradle(.kts)`. Any declared-but-unwalked module is a real
 * coverage gap (its build file was excluded or missing); the reverse is benign
 * (some modules are applied without an explicit include) and left silent.
 */
function crossCheckSettings(root: string, modules: GradleModule[]): CoverageWarning[] {
  const declared = parseSettingsInclude(root);
  if (declared.size === 0) return [];
  const foundSlugs = new Set(modules.map((m) => slug(m.path)));
  const warnings: CoverageWarning[] = [];
  for (const path of [...declared].sort()) {
    if (!foundSlugs.has(slug(path))) {
      warnings.push({
        message: `settings 声明的模块 ${path} 未在工程内找到对应 build.gradle,已跳过`,
        ref: { file: 'settings.gradle.kts', symbol: path },
      });
    }
  }
  return warnings;
}

const INCLUDE_BLOCK_RE = /\binclude\s*\(([\s\S]*?)\)/g;
const INCLUDE_BARE_RE = /\binclude\s+((?:["']:[^"']+["']\s*,?\s*)+)/g;
const GRADLE_PATH_RE = /["']:([^"']+)["']/g;

/** Canonical module paths declared in settings.gradle(.kts) — both DSL forms. */
function parseSettingsInclude(root: string): Set<string> {
  const paths = new Set<string>();
  for (const name of ['settings.gradle.kts', 'settings.gradle']) {
    let source: string;
    try {
      source = readFileSync(join(root, name), 'utf8');
    } catch {
      continue;
    }
    for (const re of [INCLUDE_BLOCK_RE, INCLUDE_BARE_RE]) {
      for (const block of source.matchAll(re)) {
        const body = block[1] ?? '';
        for (const m of body.matchAll(GRADLE_PATH_RE)) {
          if (m[1]) paths.add(`:${m[1]}`);
        }
      }
    }
  }
  return paths;
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}
