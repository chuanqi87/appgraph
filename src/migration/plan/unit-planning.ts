/**
 * P · unit planning — size the migration units to the WORK, not the project
 * layout. The SCC order (`graph.order`) stays 1:1 with ArchModules; this layer
 * re-packs it at PLAN time so unit granularity tracks code size:
 *
 *   - MERGE small units (below `minUnitSymbols`): almost every real project
 *     has a root unit — nothing depends on it, it depends on nearly
 *     everything (the final app/entry assembly) — and that root shows up as
 *     an extra "dependent" of nearly every small module, which defeats a
 *     naive dependent-set comparison. So merging strips roots out of each
 *     unit's dependent set first, then bin-packs by size every group of small
 *     units left sharing the same (root-excluded) dependent set — whether
 *     that set is empty (consumed only by roots), a single real owner (folds
 *     into it, capacity permitting), or several real consumers (grouped as
 *     siblings). A reachability check keeps every bin acyclic even though
 *     members may carry their own outgoing dependencies. Iterates to a
 *     fixpoint so merge chains collapse fully.
 *   - SPLIT an oversized single-module unit (above `maxUnitSymbols`) along its
 *     M2 subdivision Features: one sub-unit per Feature (its member files),
 *     plus a remainder sub-unit for the module's uncovered files. Sub-units
 *     order bottom-up along the Feature→Feature depends_on edges. The remainder
 *     (`rest`) is the module's LOW-COHESION grab-bag — everything no Feature
 *     captured — so it carries its OWN, much smaller budget (`maxRestSymbols` /
 *     `maxRestFiles`, NOT the module-level `maxUnitSymbols`): whenever it
 *     exceeds either, it is bin-packed by source DIRECTORY (sorted dir order)
 *     so no single `rest` slice stays an unconvertible monolith. Decoupling the
 *     two budgets is deliberate — a 3000-symbol *coherent* module can convert
 *     whole, but a 1400-symbol remainder spanning 30+ unrelated packages cannot
 *     (P3.5).
 *
 * Deliberately NOT part of the graph: `graph.order` is a graph fact that sync
 * preserves and the fingerprint covers; the packing granularity is a plan-time
 * choice (thresholds are CLI-tunable) recorded in plan.json's `planning` block.
 * The T3 verify baseline (`attrs.publicInterface`) stays per-ArchModule — a
 * planned unit is a work-order envelope, never a verification identity.
 */

import { createHash } from 'node:crypto';
import { AppNode } from '../../appgraph/schema';
import { MigrationGraph, MigrationOrder } from '../types';

export interface PlanningOptions {
  /** Units below this symbol count are candidates for merging. */
  minUnitSymbols: number;
  /** Single-module units above this symbol count are candidates for splitting. */
  maxUnitSymbols: number;
  /**
   * The split `rest` remainder's OWN symbol budget — deliberately far below
   * `maxUnitSymbols`. A remainder is a low-cohesion grab-bag (everything no
   * Feature captured), not a coherent module, so its convertible size is much
   * smaller; a remainder over this is re-sliced by source directory (P3.5).
   */
  maxRestSymbols: number;
  /**
   * The split `rest` remainder's OWN file-count budget. A remainder of many
   * small files overwhelms a converter agent even under the symbol budget
   * (koler's `:chooloolib#rest`: 67 files / 1429 symbols), so file count is a
   * first-class split dimension for the remainder (P3.5).
   */
  maxRestFiles: number;
  /** false → keep the SCC order 1:1 (the `--no-unit-planning` escape hatch). */
  enabled: boolean;
}

export const DEFAULT_PLANNING_OPTIONS: PlanningOptions = {
  minUnitSymbols: 120,
  maxUnitSymbols: 3000,
  maxRestSymbols: 600,
  maxRestFiles: 20,
  enabled: true,
};

/** One plan-time migration unit — a module, a merged pack, or a module slice. */
export interface PlannedUnit {
  /** Content-derived id (member module ids; split adds the feature sig). */
  id: string;
  /** 0-based position in the re-derived bottom-up order. */
  order: number;
  label: string;
  kind: 'module' | 'merged' | 'split';
  cyclic: boolean;
  moduleIds: string[];
  /** split only: the subdivision Feature's fingerprint, or 'rest'. */
  featureSig?: string;
  /** split only: the member files this sub-unit migrates (sorted). */
  files?: string[];
  symbolCount: number;
  /**
   * 0-based parallel wave (longest dependency depth): every unit this one
   * depends on sits in a strictly earlier wave, so units sharing a wave are
   * safe to migrate concurrently.
   */
  wave: number;
  /** Ids of the planned units this unit directly depends on (sorted). */
  dependsOnUnitIds: string[];
  /** 'dev-only' when every member module is dev-support (benchmark/test/lint). */
  necessity?: 'dev-only';
}

export interface UnitPlanningResult {
  units: PlannedUnit[];
  stats: { merged: number; split: number; total: number };
}

/**
 * Re-pack the SCC order into planned units.
 *
 * @param filesByModuleId   module id → its source files (for split remainders)
 * @param fileSymbolCounts  file path → code-symbol count (for sub-unit sizing)
 */
export function planUnits(
  order: MigrationOrder,
  graph: MigrationGraph,
  opts: PlanningOptions,
  filesByModuleId: Map<string, string[]>,
  fileSymbolCounts: Map<string, number>
): UnitPlanningResult {
  const moduleById = new Map(
    graph.nodes.filter((n) => n.kind === 'ArchModule' && n.platform === 'android').map((n) => [n.id, n])
  );
  const symbolCountOf = (moduleId: string): number => {
    const v = moduleById.get(moduleId)?.attrs?.symbolCount;
    return typeof v === 'number' ? v : 0;
  };
  const devOnlyModule = (moduleId: string): boolean =>
    moduleById.get(moduleId)?.attrs?.necessity === 'dev-only';

  let units: WorkUnit[] = [...order.units]
    .sort((a, b) => a.order - b.order)
    .map((u) => ({
      moduleIds: [...u.moduleIds].sort(),
      label: u.label,
      cyclic: u.cyclic,
      kind: 'module' as const,
      symbolCount: u.moduleIds.reduce((n, id) => n + symbolCountOf(id), 0),
      devOnly: u.moduleIds.every((id) => devOnlyModule(id)),
    }));

  // P1-3: a module's dominant Feature sig — small modules sharing one pack into
  // the same bin first, so a merged unit is a functional pack, not a size
  // coincidence. Purely a member-ordering affinity; never changes which units
  // may merge (dependency/acyclicity rules are untouched).
  const featureKeyOf = buildModuleFeatureKeys(graph);

  let merged = 0;
  if (opts.enabled) {
    const before = units.length;
    units = mergeSmallUnits(units, graph, opts, featureKeyOf);
    merged = before - units.length;
  }

  const ordered = orderPlannedUnits(units, graph);

  // Split oversized single-module units along their subdivision Features.
  const out: PlannedUnit[] = [];
  let split = 0;
  for (const unit of ordered) {
    const subUnits = opts.enabled ? trySplit(unit, graph, opts, filesByModuleId, fileSymbolCounts) : null;
    if (subUnits) {
      split++;
      if (unit.devOnly) subUnits.forEach((s) => (s.necessity = 'dev-only'));
      out.push(...subUnits);
    } else {
      out.push({
        id: unitId(unit.moduleIds),
        order: 0,
        label: unit.label,
        kind: unit.kind,
        cyclic: unit.cyclic,
        moduleIds: unit.moduleIds,
        symbolCount: unit.symbolCount,
        wave: 0,
        dependsOnUnitIds: [],
        ...(unit.devOnly ? { necessity: 'dev-only' as const } : {}),
      });
    }
  }
  out.forEach((u, i) => (u.order = i));
  annotateUnitDependencies(out, graph);

  return { units: out, stats: { merged, split, total: out.length } };
}

/**
 * Persist the unit-level scheduling structure: direct `dependsOnUnitIds`
 * (declared module deps projected onto the final units, plus the coupling
 * between split slices of one module — see `buildSplitSiblingDependency`) and
 * the Kahn `wave` (longest dependency depth). A scheduler can then answer "what
 * can run in parallel" from plan.json alone, without re-deriving the graph.
 */
function annotateUnitDependencies(units: PlannedUnit[], graph: MigrationGraph): void {
  const unitIndexesOfModule = new Map<string, number[]>();
  units.forEach((u, i) =>
    u.moduleIds.forEach((m) => {
      const list = unitIndexesOfModule.get(m) ?? [];
      list.push(i);
      unitIndexesOfModule.set(m, list);
    })
  );

  const depPairs = new Set<string>();
  for (const e of graph.edges) {
    if (e.kind !== 'depends_on' || e.provenance !== 'manifest') continue;
    if (e.attrs?.scope === 'test') continue;
    for (const from of unitIndexesOfModule.get(e.from) ?? []) {
      for (const to of unitIndexesOfModule.get(e.to) ?? []) {
        if (from !== to) depPairs.add(`${from}>${to}`);
      }
    }
  }

  // Split slices of one oversized module are coupled by the REAL Feature→Feature
  // dependency edges (not a blanket "depend on every earlier slice"), so
  // independent Feature clusters share a wave and migrate in parallel.
  const siblingDependsOn = buildSplitSiblingDependency(units, graph);

  // Deps always sit at earlier orders (orderPlannedUnits emits deps first;
  // trySplit emits a Feature slice before every slice that depends on it and
  // the `rest` glue last), so scanning j < i both finds every edge and
  // guarantees the persisted structure is a DAG by construction.
  const waves: number[] = [];
  for (let i = 0; i < units.length; i++) {
    const unit = units[i]!;
    const depIndexes: number[] = [];
    for (let j = 0; j < i; j++) {
      if (siblingDependsOn(i, j) || depPairs.has(`${i}>${j}`)) depIndexes.push(j);
    }
    const wave = depIndexes.reduce((mx, j) => Math.max(mx, waves[j]! + 1), 0);
    waves.push(wave);
    unit.wave = wave;
    unit.dependsOnUnitIds = depIndexes.map((j) => units[j]!.id).sort();
  }
}

/**
 * "Does split slice i depend on split slice j" for two slices of the SAME
 * oversized module. A Feature slice depends on another Feature slice iff the app
 * graph carries a Feature→Feature `depends_on` edge between them (the exact
 * coupling `orderFeatures` uses to order them). A `rest` glue slice depends on
 * every Feature slice of its module (glue migrates after the features it wires);
 * Feature slices never depend on a rest slice, and rest slices — including the
 * per-directory slices an oversized `rest` splits into — never depend on each
 * other. Slices of different modules, and non-split units, are handled by the
 * declared-dependency projection, so this returns false for them.
 */
function buildSplitSiblingDependency(
  units: PlannedUnit[],
  graph: MigrationGraph
): (i: number, j: number) => boolean {
  // (moduleId \0 featureSig) → Feature node id for every split-eligible Feature.
  const featureNodeBySig = new Map<string, string>();
  for (const n of graph.nodes) {
    if (n.kind !== 'Feature' || n.subtype !== 'subdivision') continue;
    const span = Array.isArray(n.attrs?.moduleSpan) ? (n.attrs!.moduleSpan as string[]) : [];
    if (span.length !== 1) continue;
    const sig = typeof n.attrs?.sig === 'string' ? n.attrs.sig : n.id;
    featureNodeBySig.set(`${span[0]}\0${sig}`, n.id);
  }
  const featureNodeIds = new Set(featureNodeBySig.values());
  const featureDepEdges = new Set<string>();
  for (const e of graph.edges) {
    if (e.kind !== 'depends_on') continue;
    if (featureNodeIds.has(e.from) && featureNodeIds.has(e.to)) featureDepEdges.add(`${e.from}\0${e.to}`);
  }

  // A split slice's Feature node id, or undefined for a `rest` slice.
  const featureIdOf = (u: PlannedUnit): string | undefined =>
    u.kind === 'split' && u.featureSig !== undefined
      ? featureNodeBySig.get(`${u.moduleIds[0]}\0${u.featureSig}`)
      : undefined;

  return (i: number, j: number): boolean => {
    const a = units[i]!;
    const b = units[j]!;
    if (a.kind !== 'split' || b.kind !== 'split' || a.moduleIds[0] !== b.moduleIds[0]) return false;
    const fa = featureIdOf(a);
    const fb = featureIdOf(b);
    if (fa !== undefined && fb !== undefined) return featureDepEdges.has(`${fa}\0${fb}`);
    // a is a rest slice → depends on every Feature slice; feature→rest and
    // rest→rest carry no dependency.
    return fa === undefined && fb !== undefined;
  };
}

// =============================================================================
// Merging
// =============================================================================

interface WorkUnit {
  moduleIds: string[];
  label: string;
  cyclic: boolean;
  kind: 'module' | 'merged';
  symbolCount: number;
  /** Every member module is dev-support (benchmark/test/lint). */
  devOnly: boolean;
}

/** Declared module→module depends_on, projected onto the current units. */
function unitAdjacency(
  units: WorkUnit[],
  graph: MigrationGraph
): { deps: Map<number, Set<number>>; dependents: Map<number, Set<number>> } {
  const unitOfModule = new Map<string, number>();
  units.forEach((u, i) => u.moduleIds.forEach((m) => unitOfModule.set(m, i)));

  const deps = new Map<number, Set<number>>();
  const dependents = new Map<number, Set<number>>();
  units.forEach((_, i) => {
    deps.set(i, new Set());
    dependents.set(i, new Set());
  });
  for (const e of graph.edges) {
    if (e.kind !== 'depends_on' || e.provenance !== 'manifest') continue;
    if (e.attrs?.scope === 'test') continue; // test-scoped deps do not order units
    const from = unitOfModule.get(e.from);
    const to = unitOfModule.get(e.to);
    if (from === undefined || to === undefined || from === to) continue;
    deps.get(from)!.add(to);
    dependents.get(to)!.add(from);
  }
  return { deps, dependents };
}

/**
 * Merge small units to a fixpoint (chains collapse fully — folding a small
 * unit into an owner can expose a new merge opportunity for the next round).
 */
function mergeSmallUnits(
  units: WorkUnit[],
  graph: MigrationGraph,
  opts: PlanningOptions,
  featureKeyOf: Map<string, string>
): WorkUnit[] {
  let current = units;
  for (;;) {
    const next = mergeSmallUnitsOnePass(current, graph, opts, featureKeyOf);
    if (next.length === current.length) return current;
    current = next;
  }
}

/**
 * module id → its dominant Feature sig (the largest subdivision/cross-module
 * Feature it participates in), for merge affinity. Empty string when a module
 * belongs to no such Feature — those sort together but after keyed ones.
 */
function buildModuleFeatureKeys(graph: MigrationGraph): Map<string, string> {
  const bestSize = new Map<string, number>();
  const key = new Map<string, string>();
  for (const n of graph.nodes) {
    if (n.kind !== 'Feature') continue;
    const role = typeof n.attrs?.role === 'string' ? n.attrs.role : n.subtype;
    if (role !== 'subdivision' && role !== 'cross-module') continue;
    const span = Array.isArray(n.attrs?.moduleSpan) ? (n.attrs!.moduleSpan as string[]) : [];
    const size = typeof n.attrs?.size === 'number' ? n.attrs.size : 0;
    const sig = typeof n.attrs?.sig === 'string' ? n.attrs.sig : n.id;
    for (const moduleId of span) {
      if (size > (bestSize.get(moduleId) ?? -1)) {
        bestSize.set(moduleId, size);
        key.set(moduleId, sig);
      }
    }
  }
  return key;
}

/** A work unit's merge-affinity key: the min feature key over its modules. */
function unitFeatureKey(unit: WorkUnit, featureKeyOf: Map<string, string>): string {
  const keys = unit.moduleIds.map((m) => featureKeyOf.get(m) ?? '').filter(Boolean).sort();
  return keys[0] ?? '';
}

/**
 * One merge round: group small units by their root-excluded dependent set,
 * bin-pack each group by size, then fold a singleton-owner group's bins into
 * that owner when capacity allows (everything else stands as its own unit).
 */
function mergeSmallUnitsOnePass(
  units: WorkUnit[],
  graph: MigrationGraph,
  opts: PlanningOptions,
  featureKeyOf: Map<string, string>
): WorkUnit[] {
  const { deps, dependents } = unitAdjacency(units, graph);

  // Root = nothing depends on it (the project's app/entry assembly is the
  // usual case). A root depending on nearly every unit would otherwise show
  // up as a near-universal extra "dependent," defeating dependent-set grouping.
  const roots = new Set<number>();
  units.forEach((_, i) => {
    if (dependents.get(i)!.size === 0) roots.add(i);
  });
  // A unit consumed by nothing but root(s) still needs somewhere to fold: if
  // there's exactly one root project-wide, it's the unambiguous owner of an
  // empty (root-excluded) dependent set. With 2+ roots, whose it "belongs" to
  // is ambiguous — leave it as its own unit rather than guess.
  const soleRoot = roots.size === 1 ? [...roots][0]! : undefined;
  const effectiveDependents = (i: number): number[] =>
    [...dependents.get(i)!].filter((d) => !roots.has(d)).sort((a, b) => a - b);

  const reachable = reachabilitySets(units.length, deps);
  const hasPath = (a: number, b: number): boolean => reachable[a]!.has(b) || reachable[b]!.has(a);

  // The bin key includes the dev-only dimension so a product unit and a
  // dev-support unit never pack into the same bin (nia's designsystem+lint) — a
  // dev-only unit ships nothing and belongs on its own track (T1-10). The
  // dependent-set (used to name a fold owner) is the part AFTER the `\0` tag.
  const groups = new Map<string, number[]>();
  units.forEach((u, i) => {
    if (u.symbolCount >= opts.minUnitSymbols) return;
    const key = `${u.devOnly ? '1' : '0'}\0${effectiveDependents(i).join(',')}`;
    const list = groups.get(key) ?? [];
    list.push(i);
    groups.set(key, list);
  });

  const consumed = new Set<number>();
  const packs: number[][] = [];
  for (const key of [...groups.keys()].sort()) {
    const members = groups.get(key)!.filter((i) => !consumed.has(i));
    if (members.length === 0) continue;
    // Feature affinity: modules sharing a dominant Feature sit adjacent so they
    // pack into the same bin; label breaks the tie (keeps the order stable).
    members.sort((a, b) => {
      const fa = unitFeatureKey(units[a]!, featureKeyOf);
      const fb = unitFeatureKey(units[b]!, featureKeyOf);
      return fa.localeCompare(fb) || units[a]!.label.localeCompare(units[b]!.label);
    });

    // Bin-pack this group's members by size; split a bin whenever adding the
    // next member would overflow it, or would create a path between two
    // members of the same bin (unrelated to their shared dependent set).
    const bins: number[][] = [];
    let bin: number[] = [];
    let binSize = 0;
    const flush = (): void => {
      if (bin.length > 0) bins.push(bin);
      bin = [];
      binSize = 0;
    };
    for (const i of members) {
      const size = units[i]!.symbolCount;
      const conflict = bin.some((j) => hasPath(i, j));
      if (bin.length > 0 && (binSize >= opts.minUnitSymbols || binSize + size > opts.maxUnitSymbols || conflict)) {
        flush();
      }
      bin.push(i);
      binSize += size;
    }
    flush();

    // A single-element key names the group's one real owner. An empty key
    // (nothing but root(s) consume these) falls back to the sole root, when
    // unambiguous. Either way, require a direct edge from candidate to EVERY
    // bin member before folding — that's what makes contracting them into one
    // node provably safe, and it correctly declines a fold for a member that
    // turns out to have no real edge to the candidate at all (e.g. a fully
    // unreferenced unit sharing the empty key by coincidence).
    const binDevOnly = key.charAt(0) === '1';
    const depSet = key.slice(key.indexOf('\0') + 1);
    const parts = depSet === '' ? [] : depSet.split(',').map(Number);
    const candidate = parts.length === 1 ? parts[0]! : parts.length === 0 ? soleRoot : undefined;

    for (const b of bins) {
      const owner =
        candidate !== undefined &&
        !consumed.has(candidate) &&
        // Keep the necessity tracks apart: never fold a dev-only bin into a
        // product owner (or vice versa) — that would re-mix what the key split (T1-10).
        units[candidate]!.devOnly === binDevOnly &&
        b.every((m) => deps.get(candidate)!.has(m))
          ? candidate
          : undefined;
      if (owner !== undefined) {
        // A bin that already reached a healthy size by packing with its
        // siblings stands on its own — folding into the owner is only for
        // a bin that's STILL small once its siblings are accounted for.
        const binSize2 = b.reduce((n, i) => n + units[i]!.symbolCount, 0);
        if (binSize2 < opts.minUnitSymbols && units[owner]!.symbolCount + binSize2 <= opts.maxUnitSymbols) {
          packs.push([owner, ...b]);
          consumed.add(owner);
          b.forEach((i) => consumed.add(i));
          continue;
        }
      }
      if (b.length >= 2) {
        packs.push(b);
        b.forEach((i) => consumed.add(i));
      }
      // A lone member with no viable owner to fold into stays standalone
      // this round (it may find a sibling once other merges reshape the
      // dependent graph, hence the outer fixpoint loop).
    }
  }
  if (packs.length === 0) return units;

  const out: WorkUnit[] = [];
  const packed = new Set<number>();
  for (const pack of packs) {
    out.push(mergeUnits(pack.map((i) => units[i]!)));
    pack.forEach((i) => packed.add(i));
  }
  units.forEach((u, i) => {
    if (!packed.has(i)) out.push(u);
  });
  return out;
}

/** All units reachable from each unit by following `deps` (forward) edges. */
function reachabilitySets(n: number, deps: Map<number, Set<number>>): Set<number>[] {
  const result: Set<number>[] = [];
  for (let i = 0; i < n; i++) {
    const seen = new Set<number>();
    const stack = [...(deps.get(i) ?? [])];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const next of deps.get(cur) ?? []) stack.push(next);
    }
    result.push(seen);
  }
  return result;
}

function mergeUnits(members: WorkUnit[]): WorkUnit {
  const moduleIds = members.flatMap((m) => m.moduleIds).sort();
  return {
    moduleIds,
    label: members
      .map((m) => m.label)
      .sort()
      .join(','),
    cyclic: members.some((m) => m.cyclic),
    kind: 'merged',
    symbolCount: members.reduce((n, m) => n + m.symbolCount, 0),
    devOnly: members.every((m) => m.devOnly),
  };
}

/**
 * Bottom-up Kahn over the planned units (same discipline as `order/topo.ts`).
 * The merge rules provably preserve acyclicity — a cycle here is a bug, so it
 * throws instead of emitting a wrong order.
 */
function orderPlannedUnits(units: WorkUnit[], graph: MigrationGraph): WorkUnit[] {
  const { deps, dependents } = unitAdjacency(units, graph);
  const outstanding = new Map<number, number>();
  units.forEach((_, i) => outstanding.set(i, deps.get(i)!.size));

  const out: WorkUnit[] = [];
  const emitted = new Set<number>();
  while (out.length < units.length) {
    // Product-first tie-break, then label — dev-support units sink below equally
    // ready product units without violating any topological constraint.
    const ready = [...outstanding.entries()]
      .filter(([i, n]) => n === 0 && !emitted.has(i))
      .map(([i]) => i)
      .sort(
        (a, b) =>
          Number(units[a]!.devOnly) - Number(units[b]!.devOnly) ||
          units[a]!.label.localeCompare(units[b]!.label)
      );
    if (ready.length === 0) {
      throw new Error('单元计划层聚合后出现依赖环(不应发生)——请用 --no-unit-planning 退回 1:1 工单并反馈');
    }
    for (const i of ready) {
      emitted.add(i);
      outstanding.delete(i);
      out.push(units[i]!);
      for (const d of dependents.get(i)!) {
        if (!emitted.has(d)) outstanding.set(d, (outstanding.get(d) ?? 1) - 1);
      }
    }
  }
  return out;
}

// =============================================================================
// Splitting
// =============================================================================

/**
 * Split an oversized single-module unit along its M2 subdivision Features.
 * Returns null when the unit doesn't qualify (multi-module, cyclic, small, or
 * no subdivision overlay to split along).
 */
function trySplit(
  unit: WorkUnit,
  graph: MigrationGraph,
  opts: PlanningOptions,
  filesByModuleId: Map<string, string[]>,
  fileSymbolCounts: Map<string, number>
): PlannedUnit[] | null {
  if (unit.kind !== 'module' || unit.cyclic || unit.moduleIds.length !== 1) return null;
  if (unit.symbolCount <= opts.maxUnitSymbols) return null;
  const moduleId = unit.moduleIds[0]!;

  const features = graph.nodes
    .filter(
      (n) =>
        n.kind === 'Feature' &&
        n.subtype === 'subdivision' &&
        Array.isArray(n.attrs?.moduleSpan) &&
        n.attrs.moduleSpan.length === 1 &&
        n.attrs.moduleSpan[0] === moduleId &&
        Array.isArray(n.attrs?.members)
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  if (features.length === 0) return null;

  const countSymbols = (files: string[]): number =>
    files.reduce((n, f) => n + (fileSymbolCounts.get(f) ?? 0), 0);

  const subUnits: PlannedUnit[] = [];
  const covered = new Set<string>();
  for (const feature of orderFeatures(features, graph)) {
    const files = [...new Set(feature.attrs!.members as string[])].sort();
    files.forEach((f) => covered.add(f));
    const sig = String(feature.attrs!.sig);
    subUnits.push({
      id: splitUnitId(moduleId, sig),
      order: 0,
      label: `${unit.label}#${feature.name}`,
      kind: 'split',
      cyclic: false,
      moduleIds: [moduleId],
      featureSig: sig,
      files,
      symbolCount: countSymbols(files),
      wave: 0,
      dependsOnUnitIds: [],
    });
  }

  // Remainder: the module's files no subdivision Feature covers (glue last). An
  // oversized remainder is re-split by source directory so it isn't one monolith.
  const rest = (filesByModuleId.get(moduleId) ?? []).filter((f) => !covered.has(f)).sort();
  for (const slice of subdivideRest(rest, opts, countSymbols)) {
    subUnits.push({
      id: splitUnitId(moduleId, slice.sig),
      order: 0,
      label: `${unit.label}#${slice.label}`,
      kind: 'split',
      cyclic: false,
      moduleIds: [moduleId],
      featureSig: slice.sig,
      files: slice.files,
      symbolCount: countSymbols(slice.files),
      wave: 0,
      dependsOnUnitIds: [],
    });
  }
  return subUnits;
}

/** One remainder ("rest") slice: its stable sig, display label, and files. */
interface RestSlice {
  sig: string;
  label: string;
  files: string[];
}

/**
 * Slice the module's uncovered `rest` files against the remainder's OWN budget
 * (`maxRestSymbols` / `maxRestFiles`, NOT `maxUnitSymbols`). Within BOTH budgets
 * — or when it degenerates to a single group — it stays ONE `rest` slice. An
 * over-budget remainder is bin-packed by SOURCE DIRECTORY: directories are
 * accumulated in sorted order and flushed whenever adding the next would
 * overflow EITHER budget (a lone over-budget directory becomes its own slice —
 * `subdivideRest` never splits within a directory). Deterministic — directory-
 * name sorted — and each slice's sig is derived from its first (sorted)
 * directory, unique across slices since the sorted directories partition
 * contiguously.
 */
function subdivideRest(
  rest: string[],
  opts: PlanningOptions,
  countSymbols: (files: string[]) => number
): RestSlice[] {
  if (rest.length === 0) return [];
  const wholeRest: RestSlice = { sig: 'rest', label: 'rest', files: rest };
  if (countSymbols(rest) <= opts.maxRestSymbols && rest.length <= opts.maxRestFiles) return [wholeRest];

  const byDir = new Map<string, string[]>();
  for (const f of rest) {
    const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
    const list = byDir.get(dir) ?? [];
    list.push(f);
    byDir.set(dir, list);
  }

  const slices: RestSlice[] = [];
  let binKey: string | null = null;
  let binFiles: string[] = [];
  let binSize = 0;
  const flush = (): void => {
    if (binFiles.length === 0 || binKey === null) return;
    slices.push({ sig: `rest:${binKey}`, label: `rest/${restDirLabel(binKey)}`, files: [...binFiles].sort() });
    binKey = null;
    binFiles = [];
    binSize = 0;
  };
  for (const dir of [...byDir.keys()].sort()) {
    const files = byDir.get(dir)!;
    const size = countSymbols(files);
    if (
      binFiles.length > 0 &&
      (binSize + size > opts.maxRestSymbols || binFiles.length + files.length > opts.maxRestFiles)
    ) {
      flush();
    }
    if (binKey === null) binKey = dir;
    binFiles.push(...files);
    binSize += size;
  }
  flush();

  // A single-bin outcome (e.g. one oversized directory) reads better as the
  // plain `rest` slice — keeps the common label the same across consumers.
  return slices.length <= 1 ? [wholeRest] : slices;
}

/** Readable label for a rest directory: the package tail after `src/…/java|kotlin/`, dotted. */
function restDirLabel(dir: string): string {
  if (dir === '') return 'root';
  const m = /(?:^|\/)src\/[^/]+\/(?:java|kotlin)\/(.+)$/.exec(dir);
  return (m ? m[1]! : dir).replace(/\//g, '.');
}

/** Bottom-up over Feature→Feature depends_on; ties by size desc, then sig. */
function orderFeatures(features: AppNode[], graph: MigrationGraph): AppNode[] {
  const idx = new Map(features.map((f, i) => [f.id, i]));
  const deps = new Map<number, Set<number>>();
  const dependents = new Map<number, Set<number>>();
  features.forEach((_, i) => {
    deps.set(i, new Set());
    dependents.set(i, new Set());
  });
  for (const e of graph.edges) {
    if (e.kind !== 'depends_on') continue;
    const from = idx.get(e.from);
    const to = idx.get(e.to);
    if (from === undefined || to === undefined || from === to) continue;
    deps.get(from)!.add(to);
    dependents.get(to)!.add(from);
  }

  const rank = (i: number): [number, string] => {
    const f = features[i]!;
    const size = typeof f.attrs?.size === 'number' ? f.attrs.size : 0;
    return [-size, String(f.attrs?.sig ?? f.id)];
  };
  const outstanding = new Map<number, number>();
  features.forEach((_, i) => outstanding.set(i, deps.get(i)!.size));
  const out: AppNode[] = [];
  const emitted = new Set<number>();
  while (out.length < features.length) {
    let ready = [...outstanding.entries()]
      .filter(([i, n]) => n === 0 && !emitted.has(i))
      .map(([i]) => i);
    // Feature edges are heuristic and may cycle — fall back to breaking the
    // smallest-ranked remaining node free instead of failing the plan.
    if (ready.length === 0) {
      ready = [[...outstanding.keys()].sort((a, b) => cmp(rank(a), rank(b)))[0]!];
    }
    ready.sort((a, b) => cmp(rank(a), rank(b)));
    for (const i of ready) {
      emitted.add(i);
      outstanding.delete(i);
      out.push(features[i]!);
      for (const d of dependents.get(i)!) {
        if (!emitted.has(d)) outstanding.set(d, Math.max(0, (outstanding.get(d) ?? 1) - 1));
      }
    }
  }
  return out;
}

function cmp(a: [number, string], b: [number, string]): number {
  return a[0] - b[0] || a[1].localeCompare(b[1]);
}

/** Same content-derived id formula as `order/topo.ts`. */
function unitId(sortedMembers: string[]): string {
  return createHash('sha1').update(sortedMembers.join('\0')).digest('hex').slice(0, 16);
}

function splitUnitId(moduleId: string, featureSig: string): string {
  return createHash('sha1').update(`${moduleId}\0${featureSig}`).digest('hex').slice(0, 16);
}
