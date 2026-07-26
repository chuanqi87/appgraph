/**
 * HarmonyOS surface projection — code-symbol graph → AppGraph-shaped facts.
 *
 * ONE deterministic projection, shared by both directions:
 *   - `appgraph build --platform harmony` (a HarmonyOS project analyzed on its
 *     own), and
 *   - `migrate verify` (the generated HarmonyOS target checked against a plan).
 *
 * Sharing it is the whole point: if the two sides projected independently they
 * could disagree about what a "screen" is, and the migration gate would compare
 * a target against a differently-derived source. `harmony-symmetry.test.ts`
 * locks the two callers to identical Screen/Capability/nav sets.
 *
 * What it recovers:
 *   - capabilities  from real `@ohos.*`/`@kit.*` `import` nodes (precise to the
 *                   import, not a comment substring),
 *   - screens       from `@Entry`/`@Component`(+NavDestination) structs,
 *   - exports       every exported class/struct/interface/enum/function with its
 *                   fields, for interface + entity fidelity,
 *   - nav edges     router route literals read per screen (the one thing the
 *                   code graph doesn't emit on its own).
 */

import { AppNode, makeNodeId, screenMatchKey, slug } from '../../schema';
import type { Node, NodeKind } from '../../../types';
import type { CodeEdge } from '../../graph-reader';
import { capabilityForImport } from '../../detect/capability-markers';
import { isNavDestinationPage } from '../../detect/arkts-source';

export type ArkExportKind = 'class' | 'struct' | 'interface' | 'enum' | 'function';

/** One exported symbol recovered from a HarmonyOS module. */
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

/** A recovered screen→screen route hop (by screen NAME, not node id). */
export interface HarmonyNavEdge {
  from: string;
  to: string;
}

/** Structural-validity signal: what the projection yielded. */
export interface HarmonySurfaceStructural {
  fileCount: number;
  classCount: number;
  methodCount: number;
  /** Capability ids detected, sorted. */
  capabilityIds: string[];
}

export interface HarmonySurface {
  capabilityNodes: AppNode[];
  screenNodes: AppNode[];
  navEdges: HarmonyNavEdge[];
  exports: ArkExport[];
  structural: HarmonySurfaceStructural;
  fileCount: number;
}

export interface ProjectHarmonySurfaceInput {
  nodes: Node[];
  edges: CodeEdge[];
  /** Project-relative path → source text. Callers memoize; '' when unreadable. */
  readSource: (filePath: string) => string;
}

/** ArkUI component decorators — presence makes a struct a component/page. */
export const HARMONY_COMPONENT_DECORATORS = new Set([
  'Entry',
  'Component',
  'ComponentV2',
  'CustomDialog',
  'Reusable',
]);

/** The export kinds that project to an ArkExport. */
const EXPORT_KINDS = new Set<NodeKind>(['class', 'struct', 'interface', 'enum', 'function']);

/** `router.pushUrl({ url: 'pages/DetailPage' })` — the classic router form. */
const PAGE_URL_RE = /['"]pages\/([A-Za-z0-9_]+)['"]/g;
/** `NavPathStack.pushPath(ByName)('DetailPage')` — the Navigation router form. */
const PUSH_PATH_RE = /pushPath(?:ByName)?\(\s*['"]([A-Za-z0-9_]+)['"]/g;

/** Deterministically project a HarmonyOS code-symbol graph into the surface. */
export function projectHarmonySurface(input: ProjectHarmonySurfaceInput): HarmonySurface {
  const { nodes, edges, readSource } = input;

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

  // Page names reused across modules must be qualified, or one module's page
  // silently absorbs the other's. Computed over the same struct population the
  // source side uses, so both derive identical ids.
  const ambiguous = ambiguousScreenNames(
    nodes.filter(
      (n) =>
        n.kind === 'struct' && (n.decorators ?? []).some((d) => HARMONY_COMPONENT_DECORATORS.has(d))
    )
  );

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
      node.kind === 'struct' && decorators.some((d) => HARMONY_COMPONENT_DECORATORS.has(d));

    // 2) Screens: @Entry always; otherwise only when the struct's OWN `build()`
    //    roots at `NavDestination` — the Navigation-system page shape. Testing
    //    the struct's build root rather than searching the file text keeps a
    //    reusable component that merely sits beside a page (or nests one in a
    //    @Builder) from inflating the screen count, and makes this agree with
    //    the source-side `harmony-pages.ts` decision node-for-node.
    if (isComponent) {
      capabilityIds.add('ui.declarative');
      const isEntry = decorators.includes('Entry');
      const isScreen = isEntry || isNavDestinationPage(structSource(node, readSource));
      if (isScreen) {
        const screen = harmonyScreenNode(node.name, node.filePath, decorators, isEntry, ambiguous);
        screenById.set(screen.id, screen);
        for (const to of routeTargets(readSource(node.filePath))) {
          navEdgeKeys.add(`${node.name}\0${to}`);
        }
      }
    }

    // 3) Exports — the public surface (interface + entity fidelity).
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

  const capabilityNodes = [...capabilityIds].sort().map((id) => harmonyCapabilityNode(id));
  const navEdges = [...navEdgeKeys].sort().map((k) => {
    const [from, to] = k.split('\0');
    return { from: from!, to: to! };
  });
  const fileCount = new Set(nodes.map((n) => n.filePath)).size;

  return {
    capabilityNodes,
    screenNodes: [...screenById.values()].sort((a, b) => a.id.localeCompare(b.id)),
    navEdges,
    exports: exports.sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file)),
    structural: {
      fileCount,
      classCount,
      methodCount,
      capabilityIds: [...capabilityIds].sort(),
    },
    fileCount,
  };
}

/**
 * The source text of a struct's own declaration, sliced from its file by the
 * node's line span (nodes carry 1-based inclusive lines).
 */
function structSource(node: Node, readSource: (filePath: string) => string): string {
  const text = readSource(node.filePath);
  if (!text) return '';
  return text.split('\n').slice(node.startLine - 1, node.endLine).join('\n');
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

/**
 * The match key for a page struct.
 *
 * A page's simple name is normally its identity (matching Android's screens).
 * But HarmonyOS projects are heavily modular and reuse page names across
 * modules — 19 of 76 corpus projects declare the same page name in two
 * different modules (`features/business_setting/…/SettingFont.ets` and
 * `components/module_app_setting/…/SettingFont.ets`). Keying on the name alone
 * collapses those into ONE node, so the loser's page disappears from the graph,
 * its module owns nothing, and its inbound navigation is dropped.
 *
 * So a name declared in more than one file is qualified by its path. `ambiguous`
 * must be the set of such names, computed from the same struct population on
 * both the source and target side so the two derive identical ids.
 */
export function harmonyScreenMatchKey(
  name: string,
  filePath: string,
  ambiguous: ReadonlySet<string>
): string {
  const base = screenMatchKey(name);
  if (!ambiguous.has(name)) return base;
  return `${base}:${slug(filePath.replace(/\.ets$/, ''))}`;
}

/** Page-struct simple names declared in more than one file. */
export function ambiguousScreenNames(structs: Array<{ name: string; filePath: string }>): Set<string> {
  const filesByName = new Map<string, Set<string>>();
  for (const s of structs) {
    const set = filesByName.get(s.name);
    if (set) set.add(s.filePath);
    else filesByName.set(s.name, new Set([s.filePath]));
  }
  const out = new Set<string>();
  for (const [name, files] of filesByName) if (files.size > 1) out.add(name);
  return out;
}

export function harmonyScreenNode(
  name: string,
  filePath: string,
  decorators: string[],
  isEntry: boolean,
  ambiguous: ReadonlySet<string> = new Set()
): AppNode {
  const matchKey = harmonyScreenMatchKey(name, filePath, ambiguous);
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

/** A HarmonyOS Capability node keyed on the SAME `capability:<id>` as Android. */
export function harmonyCapabilityNode(id: string): AppNode {
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
