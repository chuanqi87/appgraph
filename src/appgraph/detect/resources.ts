/**
 * U6 · resources + XML-View layouts.
 *
 * Two gaps this closes. (1) The majority of legacy apps (koler / NewPipe /
 * shadowsocks) build screens with the XML View system, not Compose — those
 * screens were entirely invisible (phase-1 `xml.ts` only parsed the manifest).
 * (2) `res/values/*` resources (strings/colors/themes) are the source-of-truth
 * for the target's `resources/base/element/*.json`, so they need a fact anchor.
 *
 * File-driven (like manifest-capabilities): walk the project's `res/` trees,
 * reuse appgraph's `parseXml`, and emit one Resource node per values file and
 * one `xml-layout` Screen node per layout file. Deterministic: files sorted,
 * ids content-derived, no line numbers.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  AppEdge,
  AppNode,
  CoverageWarning,
  makeEdgeId,
  makeNodeId,
  screenMatchKey,
  slug,
} from '../schema';
import { parseXml, walk } from '../extractors/android/xml';
import { ModuleRef } from './manifest-capabilities';

const EXCLUDED_DIRS = new Set([
  'build',
  '.git',
  '.gradle',
  '.idea',
  'node_modules',
  '.appgraph',
  '.codegraph',
  '.migration',
]);
const TEST_RES_RE = /\/src\/(test|androidTest|androidtest)\//i;

export interface ResourceResult {
  resourceNodes: AppNode[];
  layoutScreenNodes: AppNode[];
  containsEdges: AppEdge[];
  warnings: CoverageWarning[];
  stats: { valueFiles: number; layoutFiles: number; resourceEntries: number };
}

/** Detect resources + XML-View layout screens under `projectRoot`. */
export function detectResources(projectRoot: string, modules: ModuleRef[] = []): ResourceResult {
  const dirIndex = moduleDirIndex(modules);
  const resourceById = new Map<string, AppNode>();
  const layoutById = new Map<string, AppNode>();
  const containsById = new Map<string, AppEdge>();
  const warnings: CoverageWarning[] = [];
  let resourceEntries = 0;
  let valueFiles = 0;
  let layoutFiles = 0;

  for (const abs of findResourceXml(projectRoot)) {
    const relPath = toPosix(relative(projectRoot, abs));
    const owner = attributeModule(relPath, dirIndex);
    let source: string;
    try {
      source = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const root = parseXml(source);
    if (!root) {
      warnings.push({ message: `U6 · 无法解析资源 XML:${relPath}`, ref: { file: relPath } });
      continue;
    }

    if (isValuesFile(relPath) && root.tag === 'resources') {
      const node = valuesResourceNode(relPath, root, owner?.name);
      resourceById.set(node.id, node);
      resourceEntries += Number(node.attrs?.entryCount ?? 0);
      valueFiles++;
      addContains(containsById, owner?.id, node.id, 'resource');
    } else if (isLayoutFile(relPath)) {
      const node = layoutScreenNode(relPath, root, owner?.name);
      layoutById.set(node.id, node);
      layoutFiles++;
      addContains(containsById, owner?.id, node.id, 'screen');
    }
  }

  return {
    resourceNodes: [...resourceById.values()].sort((a, b) => a.id.localeCompare(b.id)),
    layoutScreenNodes: [...layoutById.values()].sort((a, b) => a.id.localeCompare(b.id)),
    containsEdges: [...containsById.values()].sort((a, b) => a.id.localeCompare(b.id)),
    warnings,
    stats: { valueFiles, layoutFiles, resourceEntries },
  };
}

/** One Resource node per `res/values/*.xml`, with per-type entry counts. */
function valuesResourceNode(relPath: string, root: ReturnType<typeof parseXml>, moduleName?: string): AppNode {
  const counts: Record<string, number> = {};
  const names: string[] = [];
  let total = 0;
  for (const child of root!.children) {
    counts[child.tag] = (counts[child.tag] ?? 0) + 1;
    total++;
    const name = child.attrs['name'];
    if (name && names.length < 40) names.push(name);
  }
  const matchKey = `resource:${slug(relPath)}`;
  const dominant = Object.keys(counts).sort((a, b) => (counts[b]! - counts[a]!) || a.localeCompare(b))[0];
  return {
    id: makeNodeId('android', 'Resource', matchKey),
    kind: 'Resource',
    matchKey,
    name: baseName(relPath),
    platform: 'android',
    subtype: dominant ?? 'values',
    provenance: 'source-static',
    fidelity: 'source-project',
    confidence: 1,
    platformRef: { file: relPath },
    attrs: {
      module: moduleName,
      entryCount: total,
      byType: sortedRecord(counts),
      sampleNames: names.sort(),
    },
  };
}

/** One `xml-layout` Screen node per `res/layout/*.xml`, with its control inventory. */
function layoutScreenNode(relPath: string, root: ReturnType<typeof parseXml>, moduleName?: string): AppNode {
  const controls = new Set<string>();
  walk(root!, (el) => {
    if (el.tag && !el.tag.startsWith('?')) controls.add(el.tag);
  });
  const stem = baseName(relPath).replace(/\.xml$/i, '');
  const matchKey = screenMatchKey(`layout_${stem}`);
  return {
    id: makeNodeId('android', 'Screen', matchKey),
    kind: 'Screen',
    matchKey,
    name: stem,
    platform: 'android',
    subtype: 'xml-layout',
    provenance: 'source-static',
    fidelity: 'source-project',
    confidence: 0.85,
    platformRef: { file: relPath },
    attrs: {
      module: moduleName,
      framework: 'android-view',
      rootTag: root!.tag,
      controlCount: controls.size,
      controls: [...controls].sort(),
    },
  };
}

function addContains(
  edges: Map<string, AppEdge>,
  fromModuleId: string | undefined,
  toId: string,
  kind: string
): void {
  if (!fromModuleId) return;
  const id = makeEdgeId('app_contains', fromModuleId, toId);
  if (!edges.has(id)) {
    edges.set(id, {
      id,
      kind: 'app_contains',
      from: fromModuleId,
      to: toId,
      provenance: 'source-static',
      confidence: 0.85,
      attrs: { kind },
    });
  }
}

/** Every shippable values/layout resource XML under `res/` (test source sets excluded). */
function findResourceXml(root: string): string[] {
  const out: string[] = [];
  const walkDir = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) walkDir(full);
      } else if (entry.name.endsWith('.xml')) {
        const posix = toPosix(full);
        if (TEST_RES_RE.test(posix)) continue;
        if (isValuesFile(posix) || isLayoutFile(posix)) out.push(full);
      }
    }
  };
  walkDir(root);
  return out.sort();
}

function isValuesFile(p: string): boolean {
  return /\/res\/values[^/]*\/[^/]+\.xml$/.test(p);
}
function isLayoutFile(p: string): boolean {
  return /\/res\/layout[^/]*\/[^/]+\.xml$/.test(p);
}

function moduleDirIndex(modules: ModuleRef[]): Array<{ dir: string; ref: ModuleRef }> {
  return modules
    .filter((m) => m.dir)
    .map((ref) => ({ dir: ref.dir, ref }))
    .sort((a, b) => b.dir.length - a.dir.length);
}

function attributeModule(relPath: string, dirIndex: Array<{ dir: string; ref: ModuleRef }>): ModuleRef | null {
  for (const { dir, ref } of dirIndex) {
    if (relPath === dir || relPath.startsWith(`${dir}/`)) return ref;
  }
  return null;
}

function baseName(relPath: string): string {
  return relPath.split('/').pop() ?? relPath;
}

function sortedRecord(rec: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(rec).sort()) out[k] = rec[k]!;
  return out;
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}
