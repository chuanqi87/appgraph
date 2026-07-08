/**
 * M4 · TARGET-side reconstruction via the community tree-sitter engine.
 *
 * The SOURCE side lifts its AppGraph from a `codegraph index` of the source
 * project; the TARGET side is now symmetric: index the generated HarmonyOS
 * output with the SAME community engine (the `.ets` arkts extractor), then read
 * the code-symbol graph back and project it to the target AppGraph surface:
 *   - capabilities  from real `@ohos.*`/`@kit.*` `import` nodes (precise to the
 *                   import, not a comment substring),
 *   - screens       from `@Entry`/`@Component`(+NavDestination) structs,
 *   - exports       every exported class/struct/interface/enum/function with its
 *                   fields (struct/class members), for interface + entity fidelity,
 *   - nav edges     the ONE thing the graph doesn't emit — router route literals
 *                   (`pushUrl({url:'pages/X'})` / `pushPath('X')`) read per screen.
 *
 * Indexing is auto-managed exactly like `migrate index`: open+sync an existing
 * `.codegraph/`, else init+index. Any failure degrades to an empty surface with
 * `structural.buildOk=false` so `verify` reports "target unparseable" instead of
 * throwing.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppNode, makeNodeId, screenMatchKey } from '../../appgraph/schema';
import type { NavEdge } from './structure-diff';
import { CodeSymbolGraph } from '../../appgraph/graph-reader';
import type { CodeEdge } from '../../appgraph/graph-reader';
import { CodeGraph } from '../../index';
import type { Node, NodeKind } from '../../types';
import {
  UNVERIFIABLE_CAPABILITY_IDS,
  capabilityForImport,
} from './capability-markers';

export type ArkExportKind = 'class' | 'struct' | 'interface' | 'enum' | 'function';

/** One exported symbol recovered from the generated target module. */
export interface ArkExport {
  name: string;
  kind: ArkExportKind;
  signature: string;
  file: string;
  /** True for @Component/@ComponentV2/@Entry structs (ArkUI components / pages). */
  isComponent: boolean;
  /** Declared field/property names (for entity schema fidelity), best-effort. */
  fields: string[];
}

/** Structural-validity signal: did the target index build, and what did it yield. */
export interface TargetStructural {
  buildOk: boolean;
  fileCount: number;
  classCount: number;
  methodCount: number;
  /** Capability ids detected, sorted (for the diff). */
  capabilityIds: string[];
}

/**
 * The recovered target surface. Shared by the full-project and per-unit gates so
 * the target is indexed + read once per verify.
 */
export interface TargetSurface {
  /** Always 'codegraph' now — the single community tree-sitter path. */
  method: 'codegraph';
  capabilityNodes: AppNode[];
  screenNodes: AppNode[];
  /** Router navigation edges recovered from route literals (from → to page). */
  navEdges: NavEdge[];
  exports: ArkExport[];
  structural: TargetStructural;
  fileCount: number;
  /** Capability ids that carry no auto-detectable marker (construct mappings). */
  unverifiable: string[];
}

/** ArkUI component decorators — presence makes a struct a component/page. */
const COMPONENT_DECORATORS = new Set(['Entry', 'Component', 'ComponentV2', 'CustomDialog', 'Reusable']);
/** The export kinds that project to an ArkExport. */
const EXPORT_KINDS = new Set<NodeKind>(['class', 'struct', 'interface', 'enum', 'function']);

/** `router.pushUrl({ url: 'pages/DetailPage' })` — the classic router form. */
const PAGE_URL_RE = /['"]pages\/([A-Za-z0-9_]+)['"]/g;
/** `NavPathStack.pushPath(ByName)('DetailPage')` — the Navigation router form. */
const PUSH_PATH_RE = /pushPath(?:ByName)?\(\s*['"]([A-Za-z0-9_]+)['"]/g;

/** Index (auto-managed) the generated target and project it to the surface. */
export async function resolveTargetSurface(targetRoot: string): Promise<TargetSurface> {
  try {
    await ensureIndexed(targetRoot);
  } catch {
    return emptySurface();
  }

  let reader: CodeSymbolGraph;
  try {
    reader = CodeSymbolGraph.open(targetRoot);
  } catch {
    return emptySurface();
  }
  try {
    return projectSurface(targetRoot, reader.getAllNodes(), reader.getAllEdges());
  } catch {
    return emptySurface();
  } finally {
    reader.close();
  }
}

/** open+sync an existing `.codegraph/`, else init+index — mirrors `migrate index`. */
async function ensureIndexed(targetRoot: string): Promise<void> {
  const cg = CodeGraph.isInitialized(targetRoot)
    ? await CodeGraph.open(targetRoot, { sync: true })
    : await CodeGraph.init(targetRoot, { index: true });
  cg.close();
}

/** Deterministically project the code-symbol graph into the target surface. */
function projectSurface(targetRoot: string, nodes: Node[], edges: CodeEdge[]): TargetSurface {
  const sourceCache = new Map<string, string>();
  const readSource = (filePath: string): string => {
    let src = sourceCache.get(filePath);
    if (src === undefined) {
      try {
        src = readFileSync(join(targetRoot, filePath), 'utf8');
      } catch {
        src = '';
      }
      sourceCache.set(filePath, src);
    }
    return src;
  };

  // struct/class members, by parent id (for export field recovery).
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const membersByParent = new Map<string, Node[]>();
  for (const e of edges) {
    if (e.kind !== 'contains') continue;
    const child = byId.get(e.target);
    if (!child) continue;
    const bucket = membersByParent.get(e.source);
    if (bucket) bucket.push(child);
    else membersByParent.set(e.source, [child]);
  }

  const capabilityIds = new Set<string>();
  const screenById = new Map<string, AppNode>();
  const navEdgeKeys = new Set<string>();
  const exports: ArkExport[] = [];
  let classCount = 0;
  let methodCount = 0;

  for (const node of nodes) {
    if (node.kind === 'class' || node.kind === 'struct') classCount++;
    if (node.kind === 'method' || node.kind === 'function') methodCount++;

    // 1) Capabilities from real @ohos.*/@kit.* imports (precise to the import).
    if (node.kind === 'import') {
      const cap = capabilityForImport(node.name);
      if (cap) capabilityIds.add(cap);
      continue;
    }

    const decorators = node.decorators ?? [];
    const isComponent =
      node.kind === 'struct' && decorators.some((d) => COMPONENT_DECORATORS.has(d));

    // 2) Screens: @Entry always; @Component only when the file wires Navigation
    //    (`NavDestination(`) — keeps reusable components from inflating the count.
    if (isComponent) {
      capabilityIds.add('ui.declarative');
      const isEntry = decorators.includes('Entry');
      const isScreen = isEntry || readSource(node.filePath).includes('NavDestination(');
      if (isScreen) {
        const screen = screenNode(node.name, node.filePath, decorators, isEntry);
        screenById.set(screen.id, screen);
        for (const to of routeTargets(readSource(node.filePath))) {
          navEdgeKeys.add(`${node.name}\0${to}`);
        }
      }
    }

    // 3) Exports — the target's public surface (interface + entity fidelity).
    if (node.isExported && EXPORT_KINDS.has(node.kind)) {
      exports.push({
        name: node.name,
        kind: node.kind as ArkExportKind,
        signature: node.signature ?? node.name,
        file: node.filePath,
        isComponent,
        fields: fieldNames(membersByParent.get(node.id)),
      });
    }
  }

  const capabilityNodes = [...capabilityIds]
    .sort()
    .map((id) => harmonyCapabilityNode(id));
  const navEdges = [...navEdgeKeys].sort().map((k) => {
    const [from, to] = k.split('\0');
    return { from: from!, to: to! };
  });
  const fileCount = new Set(nodes.map((n) => n.filePath)).size;

  return {
    method: 'codegraph',
    capabilityNodes,
    screenNodes: [...screenById.values()].sort((a, b) => a.id.localeCompare(b.id)),
    navEdges,
    exports: exports.sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file)),
    structural: {
      buildOk: true,
      fileCount,
      classCount,
      methodCount,
      capabilityIds: [...capabilityIds].sort(),
    },
    fileCount,
    unverifiable: UNVERIFIABLE_CAPABILITY_IDS,
  };
}

/** Struct/class member property/field names, sorted (for entity schema fidelity). */
function fieldNames(members: Node[] | undefined): string[] {
  if (!members) return [];
  return members
    .filter((m) => m.kind === 'property' || m.kind === 'field')
    .map((m) => m.name)
    .filter((n) => n.length > 0)
    .sort();
}

/** Route page basenames referenced from a screen's source. */
function routeTargets(source: string): string[] {
  const targets = new Set<string>();
  for (const m of source.matchAll(PAGE_URL_RE)) if (m[1]) targets.add(m[1]);
  for (const m of source.matchAll(PUSH_PATH_RE)) if (m[1]) targets.add(m[1]);
  return [...targets].sort();
}

function screenNode(name: string, filePath: string, decorators: string[], isEntry: boolean): AppNode {
  const matchKey = screenMatchKey(name);
  return {
    id: makeNodeId('harmony', 'Screen', matchKey),
    kind: 'Screen',
    matchKey,
    name,
    platform: 'harmony',
    subtype: isEntry ? 'entry-page' : 'component',
    platformRef: { file: filePath, symbol: name },
    provenance: 'source-static',
    fidelity: 'source-project',
    confidence: 0.9,
    attrs: { file: filePath, decorators },
  };
}

/** A HarmonyOS Capability node keyed on the SAME `capability:<id>` as the source. */
function harmonyCapabilityNode(id: string): AppNode {
  const matchKey = `capability:${id}`;
  return {
    id: makeNodeId('harmony', 'Capability', matchKey),
    kind: 'Capability',
    matchKey,
    name: id,
    platform: 'harmony',
    provenance: 'source-static',
    fidelity: 'source-project',
    confidence: 0.9,
  };
}

/** Degraded surface — indexing/reading failed; verify reports it as unparseable. */
function emptySurface(): TargetSurface {
  return {
    method: 'codegraph',
    capabilityNodes: [],
    screenNodes: [],
    navEdges: [],
    exports: [],
    structural: { buildOk: false, fileCount: 0, classCount: 0, methodCount: 0, capabilityIds: [] },
    fileCount: 0,
    unverifiable: UNVERIFIABLE_CAPABILITY_IDS,
  };
}
