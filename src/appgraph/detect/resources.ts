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
import { parseXml, walk, XmlElement } from '../extractors/android/xml';
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

// -- Control-tree caps (T2) — keep the extracted layout tree bounded + stable. --
/** Max control nodes captured per layout tree (rest elided, marked truncated). */
const MAX_CONTROL_NODES = 200;
/** Max nesting depth captured; deeper subtrees are elided + marked truncated. */
const MAX_CONTROL_DEPTH = 12;
/** Max characters kept for any summarized attribute value. */
const MAX_ATTR_VALUE_LEN = 48;
/** Max `<string>` key names retained per values file (module aggregation caps again). */
const STRING_NAMES_PER_FILE = 80;

/**
 * A compact Android View element in a layout's control tree (T2). ArkUI has no
 * View inheritance, so a layout can't be translated 1:1 — the conversion agent
 * needs the *structure* (nesting + key attrs) to rebuild it as `@Component` /
 * `@Builder`. Deliberately compact: only the id + a handful of key attributes,
 * never the full attribute set. Children are in SOURCE order (deterministic).
 */
export interface ControlNode {
  /** Element tag (`LinearLayout`, `TextView`, `include`, …). */
  tag: string;
  /** `android:id` with the `@+id/` / `@id/` prefix stripped, when present. */
  id?: string;
  /** Key-attribute summary (text/hint/src refs, orientation, coarse size). */
  attrs?: Record<string, string>;
  /** For `<include>`: the referenced layout stem (`@layout/foo` → `foo`). */
  include?: string;
  /** Child elements, in source order. */
  children?: ControlNode[];
  /** True when this node's subtree was elided by the node/depth cap. */
  truncated?: boolean;
}

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
  const stringNames: string[] = [];
  let total = 0;
  for (const child of root!.children) {
    counts[child.tag] = (counts[child.tag] ?? 0) + 1;
    total++;
    const name = child.attrs['name'];
    if (name && names.length < 40) names.push(name);
    // `<string>` keys drive the target's element/string.json — kept separately so
    // the module brief can list the actual i18n keys (not colors/dimens/styles).
    if (name && child.tag === 'string' && stringNames.length < STRING_NAMES_PER_FILE) {
      stringNames.push(name);
    }
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
      stringNames: stringNames.sort(),
    },
  };
}

/** One `xml-layout` Screen node per `res/layout/*.xml`, with its control inventory. */
function layoutScreenNode(relPath: string, root: ReturnType<typeof parseXml>, moduleName?: string): AppNode {
  const controls = new Set<string>();
  let totalControls = 0;
  walk(root!, (el) => {
    if (el.tag && !el.tag.startsWith('?')) {
      controls.add(el.tag);
      totalControls++;
    }
  });
  const tree = buildControlTree(root!);
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
      // Distinct control-tag set (unchanged) + true total element count (T2).
      controlCount: controls.size,
      controls: [...controls].sort(),
      totalControls,
      controlTree: tree.root,
      ...(tree.truncated ? { controlTreeTruncated: true } : {}),
    },
  };
}

/** Node-budget carried through the recursive control-tree build. */
interface TreeBudget {
  remaining: number;
  truncated: boolean;
}

/**
 * Build a compact, bounded control tree from a layout's root element (T2).
 * Caps: ≤ `MAX_CONTROL_NODES` nodes, ≤ `MAX_CONTROL_DEPTH` deep — the excess is
 * elided and flagged (`truncated`) so a giant layout can never bloat the graph
 * or the brief. Source order is preserved (deterministic).
 */
function buildControlTree(root: XmlElement): { root: ControlNode; truncated: boolean } {
  const budget: TreeBudget = { remaining: MAX_CONTROL_NODES, truncated: false };
  const node = buildControlNode(root, 0, budget) ?? { tag: root.tag, truncated: true };
  return { root: node, truncated: budget.truncated };
}

function buildControlNode(el: XmlElement, depth: number, budget: TreeBudget): ControlNode | null {
  if (budget.remaining <= 0) {
    budget.truncated = true;
    return null;
  }
  budget.remaining--;

  const node: ControlNode = { tag: el.tag };
  const id = controlId(el);
  if (id) node.id = id;
  const attrs = summarizeControlAttrs(el);
  if (Object.keys(attrs).length > 0) node.attrs = attrs;
  const included = includedLayout(el);
  if (included) node.include = included;

  const realChildren = el.children.filter((c) => c.tag && !c.tag.startsWith('?'));
  if (realChildren.length === 0) return node;

  if (depth >= MAX_CONTROL_DEPTH) {
    node.truncated = true; // depth cap: this node's subtree is elided
    budget.truncated = true;
    return node;
  }
  const kids: ControlNode[] = [];
  for (const child of realChildren) {
    const cn = buildControlNode(child, depth + 1, budget);
    if (cn === null) {
      node.truncated = true; // node cap hit mid-subtree
      break;
    }
    kids.push(cn);
  }
  if (kids.length > 0) node.children = kids;
  return node;
}

/** `android:id="@+id/title"` → `title` (also `@id/…`, `@android:id/…`). */
function controlId(el: XmlElement): string | undefined {
  const raw = el.attrs['android:id'];
  if (!raw) return undefined;
  return raw.replace(/^@\+?(?:android:)?id\//, '') || undefined;
}

/** `@layout/foo` (an `<include>`'s target) → `foo`. */
function includedLayout(el: XmlElement): string | undefined {
  if (el.tag !== 'include') return undefined;
  const layout = el.attrs['layout'];
  if (!layout) return undefined;
  return layout.replace(/^@layout\//, '') || undefined;
}

/**
 * A handful of migration-relevant attributes, compacted. Not the full attr set —
 * just what a conversion agent needs to recognise the widget: its text/hint
 * (usually a `@string` ref that maps to element/string.json), its image src
 * (`@drawable`), its orientation, and coarse size.
 */
function summarizeControlAttrs(el: XmlElement): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (key: string, value: string | undefined): void => {
    if (value) out[key] = clip(value);
  };
  put('text', el.attrs['android:text']);
  put('hint', el.attrs['android:hint']);
  put('src', el.attrs['android:src'] ?? el.attrs['app:srcCompat']);
  put('orientation', el.attrs['android:orientation']);
  put('w', coarseSize(el.attrs['android:layout_width']));
  put('h', coarseSize(el.attrs['android:layout_height']));
  return out;
}

/** `match_parent` → `match`, `wrap_content` → `wrap`, `fill_parent` → `fill`, else kept. */
function coarseSize(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value === 'match_parent') return 'match';
  if (value === 'wrap_content') return 'wrap';
  if (value === 'fill_parent') return 'fill';
  return value;
}

function clip(value: string): string {
  const v = value.trim();
  return v.length > MAX_ATTR_VALUE_LEN ? v.slice(0, MAX_ATTR_VALUE_LEN - 1) + '…' : v;
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
