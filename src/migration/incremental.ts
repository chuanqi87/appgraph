/**
 * I1 · incremental sync — recompute only what changed, and report it.
 *
 * The base code-symbol graph is synced incrementally by codegraph (`migrate
 * index` re-parses only changed files). Because every migration node/edge id is
 * a content hash that excludes line numbers (`makeNodeId`), an unchanged Feature
 * / module / capability keeps its id across runs — so a plain id-set diff of the
 * before/after migration graphs precisely isolates what actually changed, and
 * which migration UNITS therefore need re-migration.
 *
 * This module is pure graph algebra (no I/O); the `migrate sync` command wires
 * it: snapshot → rebuild structural stages → diff → report.
 */

import { AppNode } from './schema';
import { canonicalJson } from './serialize';
import { MigrationGraph } from './types';

export interface NodeRef {
  id: string;
  kind: string;
  name: string;
}

/** What changed for one migration module between two graph snapshots. */
export interface ModuleChange {
  moduleId: string;
  name: string;
  /** 'added' | 'removed' | 'changed' (symbol count, capability set, or U7 facts moved). */
  change: 'added' | 'removed' | 'changed';
  capabilitiesAdded: string[];
  capabilitiesRemoved: string[];
  symbolCountBefore?: number;
  symbolCountAfter?: number;
  /** U7 semantic acceptance facts (constants + test contract) changed. */
  semanticsChanged?: boolean;
}

export interface MigrationDiff {
  nodesAdded: NodeRef[];
  nodesRemoved: NodeRef[];
  edgesAdded: number;
  edgesRemoved: number;
  /** App-level capability set movement. */
  capabilities: { added: string[]; removed: string[] };
  /** Feature clusters whose deterministic member fingerprint changed. */
  featuresChanged: string[];
  /** Per-module change list — the units that need re-migration. */
  modules: ModuleChange[];
  unchanged: boolean;
}

/** Diff two migration graphs by stable id, isolating real change from noise. */
export function diffMigrationGraphs(before: MigrationGraph, after: MigrationGraph): MigrationDiff {
  const beforeNodes = new Map(before.nodes.map((n) => [n.id, n]));
  const afterNodes = new Map(after.nodes.map((n) => [n.id, n]));

  const nodesAdded = [...afterNodes.values()]
    .filter((n) => !beforeNodes.has(n.id))
    .map(nodeRef);
  const nodesRemoved = [...beforeNodes.values()]
    .filter((n) => !afterNodes.has(n.id))
    .map(nodeRef);

  const beforeEdges = new Set(before.edges.map((e) => e.id));
  const afterEdges = new Set(after.edges.map((e) => e.id));
  const edgesAdded = [...afterEdges].filter((id) => !beforeEdges.has(id)).length;
  const edgesRemoved = [...beforeEdges].filter((id) => !afterEdges.has(id)).length;

  const capabilities = capabilityDiff(before, after);
  const featuresChanged = featureFingerprintDiff(before, after);
  const modules = moduleChanges(before, after);

  return {
    nodesAdded: sortRefs(nodesAdded),
    nodesRemoved: sortRefs(nodesRemoved),
    edgesAdded,
    edgesRemoved,
    capabilities,
    featuresChanged,
    modules,
    unchanged:
      nodesAdded.length === 0 &&
      nodesRemoved.length === 0 &&
      edgesAdded === 0 &&
      edgesRemoved === 0 &&
      modules.length === 0,
  };
}

/** App-level capability set movement (source-side android capabilities). */
function capabilityDiff(
  before: MigrationGraph,
  after: MigrationGraph
): { added: string[]; removed: string[] } {
  const caps = (g: MigrationGraph): Set<string> =>
    new Set(
      g.nodes
        .filter((n) => n.kind === 'Capability' && n.platform === 'android')
        .map((n) => n.name)
    );
  const b = caps(before);
  const a = caps(after);
  return {
    added: [...a].filter((c) => !b.has(c)).sort(),
    removed: [...b].filter((c) => !a.has(c)).sort(),
  };
}

/**
 * Features whose deterministic member fingerprint (`attrs.sig`) changed. A new
 * or dropped Feature id counts too. Keyed by hub name for a readable report.
 */
function featureFingerprintDiff(before: MigrationGraph, after: MigrationGraph): string[] {
  const sigOf = (g: MigrationGraph): Map<string, string> => {
    const m = new Map<string, string>();
    for (const n of g.nodes) {
      if (n.kind !== 'Feature') continue;
      const sig = typeof n.attrs?.sig === 'string' ? n.attrs.sig : n.id;
      m.set(n.name, sig);
    }
    return m;
  };
  const b = sigOf(before);
  const a = sigOf(after);
  const changed = new Set<string>();
  for (const [name, sig] of a) if (b.get(name) !== sig) changed.add(name);
  for (const [name] of b) if (!a.has(name)) changed.add(name);
  return [...changed].sort();
}

/** Per-module change detection: added/removed/changed (symbols or capabilities). */
function moduleChanges(before: MigrationGraph, after: MigrationGraph): ModuleChange[] {
  const beforeMods = archModules(before);
  const afterMods = archModules(after);
  const beforeCaps = moduleCapabilityMap(before);
  const afterCaps = moduleCapabilityMap(after);

  const out: ModuleChange[] = [];
  const allIds = new Set([...beforeMods.keys(), ...afterMods.keys()]);
  for (const id of allIds) {
    const b = beforeMods.get(id);
    const a = afterMods.get(id);
    if (a && !b) {
      out.push(baseChange(id, a, 'added', new Set(), afterCaps.get(id) ?? new Set()));
      continue;
    }
    if (b && !a) {
      out.push(baseChange(id, b, 'removed', beforeCaps.get(id) ?? new Set(), new Set()));
      continue;
    }
    if (!a || !b) continue;

    const bc = beforeCaps.get(id) ?? new Set<string>();
    const ac = afterCaps.get(id) ?? new Set<string>();
    const symBefore = num(b.attrs?.symbolCount);
    const symAfter = num(a.attrs?.symbolCount);
    const capsChanged = !setEqual(bc, ac);
    const semanticsChanged = semanticsSig(b) !== semanticsSig(a);
    if (capsChanged || symBefore !== symAfter || semanticsChanged) {
      const c = baseChange(id, a, 'changed', bc, ac);
      c.symbolCountBefore = symBefore;
      c.symbolCountAfter = symAfter;
      if (semanticsChanged) c.semanticsChanged = true;
      out.push(c);
    }
  }
  return out.sort((x, y) => x.name.localeCompare(y.name));
}

function baseChange(
  moduleId: string,
  node: AppNode,
  change: ModuleChange['change'],
  before: Set<string>,
  after: Set<string>
): ModuleChange {
  return {
    moduleId,
    name: node.name,
    change,
    capabilitiesAdded: [...after].filter((c) => !before.has(c)).sort(),
    capabilitiesRemoved: [...before].filter((c) => !after.has(c)).sort(),
  };
}

function archModules(g: MigrationGraph): Map<string, AppNode> {
  return new Map(
    g.nodes.filter((n) => n.kind === 'ArchModule' && n.platform === 'android').map((n) => [n.id, n])
  );
}

/** module id → set of capability node names it uses (via uses_capability edges). */
function moduleCapabilityMap(g: MigrationGraph): Map<string, Set<string>> {
  const capName = new Map(
    g.nodes.filter((n) => n.kind === 'Capability').map((n) => [n.id, n.name])
  );
  const out = new Map<string, Set<string>>();
  for (const e of g.edges) {
    if (e.kind !== 'uses_capability') continue;
    const name = capName.get(e.to);
    if (!name) continue;
    let set = out.get(e.from);
    if (!set) {
      set = new Set<string>();
      out.set(e.from, set);
    }
    set.add(name);
  }
  return out;
}

function nodeRef(n: AppNode): NodeRef {
  return { id: n.id, kind: n.kind, name: n.name };
}
function sortRefs(refs: NodeRef[]): NodeRef[] {
  return refs.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}
function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}
/**
 * Canonical fingerprint of a module's U7 acceptance facts (constants + test
 * contract). Two runs over unchanged source produce byte-identical attrs, so a
 * string inequality here is a real semantic change even when symbolCount held.
 */
function semanticsSig(node: AppNode): string {
  return canonicalJson({ constants: node.attrs?.constants, testContract: node.attrs?.testContract });
}
function setEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
