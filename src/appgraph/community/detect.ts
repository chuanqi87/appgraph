/**
 * M2 · detection — deterministic community detection over the file coupling
 * graph. A faithful TS/graphology port of the valuable parts of graphify's
 * `cluster.py`: Louvain partition → split oversized communities → re-split
 * low-cohesion communities → deterministic hub naming → membership fingerprint →
 * size-descending re-index (total order for stable ids).
 *
 * Determinism (the whole point — fingerprints must be reproducible so the
 * incremental path can tell real change from noise): Louvain runs with a seeded
 * RNG and `randomWalk:false`, and every node/edge is inserted in sorted order.
 */

import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import { isBuildFilePath } from '../detect/shared';

// Ported constants from cluster.py — the split/cohesion thresholds.
const MAX_COMMUNITY_FRACTION = 0.25; // communities larger than 25% of the graph get split
const MIN_SPLIT_SIZE = 10; // only split if the community has at least this many nodes
const COHESION_SPLIT_THRESHOLD = 0.05; // re-split communities with cohesion below this
const COHESION_SPLIT_MIN_SIZE = 50; // only cohesion-split large communities
const LOUVAIN_SEED = 0x9e3779b9; // fixed seed → reproducible partitions

// P1-4 · module-span-aware re-split (needs the module map, so it is gated on
// `moduleOfFile`). A community sprawling across many modules with weak cohesion
// is almost always hub-bridged unrelated subsystems (the nowinandroid "NiaApp"
// 14-module grab-bag) rather than one feature. These fire on a SMALL span/
// cohesion window on purpose — the size/cohesion passes above already caught the
// large dense cases; this only targets the wide-but-thin cluster they miss.
const MODULE_SPAN_SPLIT = 6; // >6 distinct modules in one community
const MODULE_SPAN_COHESION = 0.15; // and cohesion below this → re-split

export interface Community {
  /** 0-based, largest-first (total order via sorted-members tiebreak). */
  id: number;
  /** Member file paths, sorted. */
  members: string[];
  /** Intra-community edge density in [0,1]. */
  cohesion: number;
  /** Deterministic hub label (highest-degree member's base name). */
  hubName: string;
  /** 16-hex fingerprint of the sorted membership — stable across runs. */
  sig: string;
}

export interface DetectOptions {
  /**
   * file path → owning module id (any stable key). When provided, enables the
   * P1-4 module-span-aware re-split of cross-module grab-bags. Omitting it keeps
   * detection module-agnostic (the pre-P1-4 behaviour).
   */
  moduleOfFile?: (file: string) => string | undefined;
}

/** Detect communities. Returns [] for an empty graph. */
export function detectCommunities(graph: Graph, opts: DetectOptions = {}): Community[] {
  if (graph.order === 0) return [];

  const raw = partitionToCommunities(graph, 1.0);

  // Split oversized communities (a second partition on the induced subgraph).
  const maxSize = Math.max(MIN_SPLIT_SIZE, Math.floor(graph.order * MAX_COMMUNITY_FRACTION));
  let communities: string[][] = [];
  for (const members of raw) {
    if (members.length > maxSize) communities.push(...splitCommunity(graph, members));
    else communities.push(members);
  }

  // Re-split large, low-cohesion communities (hub-bridged, unrelated subsystems).
  const second: string[][] = [];
  for (const members of communities) {
    if (members.length >= COHESION_SPLIT_MIN_SIZE && cohesion(graph, members) < COHESION_SPLIT_THRESHOLD) {
      const splits = splitCommunity(graph, members);
      second.push(...(splits.length > 1 ? splits : [members]));
    } else {
      second.push(members);
    }
  }
  communities = second;

  // P1-4: break up cross-module grab-bags the size/cohesion passes miss.
  if (opts.moduleOfFile) {
    communities = resplitCrossModuleGrabBags(communities, graph, opts.moduleOfFile);
  }

  // T1-8: Gradle/build scripts influenced the Louvain partition but are never
  // product features — drop them from the reported membership (and any community
  // left empty by the drop) so no Feature is named after a `build.gradle.kts`.
  communities = communities
    .map((members) => members.filter((m) => !isBuildFilePath(m)))
    .filter((members) => members.length > 0);

  // Total order: size desc, then lexical by sorted members → stable ids.
  communities.sort(
    (a, b) => b.length - a.length || sortedJoin(a).localeCompare(sortedJoin(b))
  );

  return communities.map((members, id) => {
    const sorted = [...members].sort();
    const coh = cohesion(graph, sorted);
    return {
      id,
      members: sorted,
      cohesion: coh,
      hubName: hubLabel(graph, sorted, coh, opts.moduleOfFile),
      sig: memberSig(sorted),
    };
  });
}

/**
 * P1-4 · break up cross-module grab-bags the size/cohesion passes miss — a
 * community spanning >6 modules with cohesion <0.15 is unrelated subsystems
 * glued by a hub, not one feature. Only keep a re-split when it actually
 * separates the cluster into >1 part (otherwise it is genuinely coupled).
 *
 * Exported for testing: the first Louvain pass never emits such a community on a
 * synthetic graph — a splittable cluster is split by that first pass too — so
 * this stage can only be exercised directly, with a pre-formed community.
 */
export function resplitCrossModuleGrabBags(
  communities: string[][],
  graph: Graph,
  moduleOfFile: (file: string) => string | undefined
): string[][] {
  const spanOf = (members: string[]): number =>
    new Set(members.map(moduleOfFile).filter((m): m is string => m !== undefined)).size;
  const out: string[][] = [];
  for (const members of communities) {
    if (spanOf(members) > MODULE_SPAN_SPLIT && cohesion(graph, members) < MODULE_SPAN_COHESION) {
      const splits = splitCommunity(graph, members);
      out.push(...(splits.length > 1 ? splits : [members]));
    } else {
      out.push(members);
    }
  }
  return out;
}

/** Run seeded Louvain and group node → cid into cid → members. */
function partitionToCommunities(graph: Graph, resolution: number): string[][] {
  const mapping = louvain(graph, {
    rng: mulberry32(LOUVAIN_SEED),
    randomWalk: false,
    resolution,
    getEdgeWeight: 'weight',
  });
  const byCid = new Map<number, string[]>();
  for (const node of [...graph.nodes()].sort()) {
    const cid = mapping[node]!;
    let bucket = byCid.get(cid);
    if (!bucket) {
      bucket = [];
      byCid.set(cid, bucket);
    }
    bucket.push(node);
  }
  return [...byCid.values()];
}

/** Second partition pass over a community's induced subgraph. */
function splitCommunity(graph: Graph, members: string[]): string[][] {
  const sub = inducedSubgraph(graph, members);
  if (sub.size === 0) return members.map((n) => [n]).sort((a, b) => a[0]!.localeCompare(b[0]!));
  const parts = partitionToCommunities(sub, 1.0);
  if (parts.length <= 1) return [members];
  return parts;
}

/** Build the undirected weighted subgraph induced by `members`. */
function inducedSubgraph(graph: Graph, members: string[]): Graph {
  const set = new Set(members);
  const sub = new Graph({ type: 'undirected', multi: false });
  for (const n of [...members].sort()) sub.addNode(n);
  const seen: Array<[string, string, number]> = [];
  graph.forEachEdge((_e, attr, s, t) => {
    if (set.has(s) && set.has(t)) {
      const [a, b] = s < t ? [s, t] : [t, s];
      seen.push([a, b, (attr as { weight?: number }).weight ?? 1]);
    }
  });
  seen.sort((x, y) => x[0].localeCompare(y[0]) || x[1].localeCompare(y[1]));
  for (const [a, b, w] of seen) if (!sub.hasEdge(a, b)) sub.addEdge(a, b, { weight: w });
  return sub;
}

/** Intra-community edge density: actual edges / max possible (n·(n-1)/2). */
function cohesion(graph: Graph, members: string[]): number {
  const n = members.length;
  if (n <= 1) return 1.0;
  const set = new Set(members);
  let actual = 0;
  for (const node of members) {
    graph.forEachNeighbor(node, (nb) => {
      if (set.has(nb) && node < nb) actual++;
    });
  }
  const possible = (n * (n - 1)) / 2;
  return possible > 0 ? actual / possible : 0;
}

/** Neutral label for a low-trust cross-module grab-bag — naming it after any one
 *  member would falsely imply a coherent feature. */
const NEUTRAL_HUB_LABEL = '杂合簇';

/**
 * Deterministic advisory label for a community.
 *
 * The hub is the highest-degree member (tie-broken by id), but chosen only from
 * the community's PRIMARY module (the one contributing the most members) so a
 * cross-module cluster is never named after a symbol belonging to a different
 * subsystem (the auth cluster mis-named `ProductHuntService` bug). A wide + thin
 * cross-module cluster is a low-trust grab-bag — mirroring the P1-4 re-split
 * window — and gets a neutral label instead of any member name. Build/script
 * files are never hub candidates. The label is advisory and never participates
 * in identity (that is the membership `sig`).
 */
function hubLabel(
  graph: Graph,
  members: string[],
  cohesionValue: number,
  moduleOfFile?: (file: string) => string | undefined
): string {
  let candidates = members.filter((m) => !isBuildFilePath(m));
  if (candidates.length === 0) candidates = members;

  if (moduleOfFile) {
    const countByModule = new Map<string, number>();
    for (const m of candidates) {
      const mod = moduleOfFile(m);
      if (mod !== undefined) countByModule.set(mod, (countByModule.get(mod) ?? 0) + 1);
    }
    if (countByModule.size > MODULE_SPAN_SPLIT && cohesionValue < MODULE_SPAN_COHESION) {
      return NEUTRAL_HUB_LABEL;
    }
    const primary = pickPrimaryModule(countByModule);
    if (primary !== undefined) {
      const restricted = candidates.filter((m) => moduleOfFile(m) === primary);
      if (restricted.length > 0) candidates = restricted;
    }
  }

  let hub = candidates[0]!;
  let best = -1;
  for (const n of candidates) {
    const d = graph.degree(n);
    if (d > best || (d === best && n < hub)) {
      best = d;
      hub = n;
    }
  }
  return basename(hub).replace(/\.[^.]+$/, '') || hub;
}

/** The module contributing the most members (ties → lexically smallest key). */
function pickPrimaryModule(countByModule: Map<string, number>): string | undefined {
  let primary: string | undefined;
  let bestCount = -1;
  for (const mod of [...countByModule.keys()].sort()) {
    const count = countByModule.get(mod)!;
    if (count > bestCount) {
      bestCount = count;
      primary = mod;
    }
  }
  return primary;
}

/** sha256(sorted members) first 16 hex — the stable membership fingerprint. */
function memberSig(sortedMembers: string[]): string {
  const h = createHash('sha256');
  for (const m of sortedMembers) {
    h.update(m, 'utf8');
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

function sortedJoin(members: string[]): string {
  return [...members].sort().join('\n');
}

/** Deterministic 32-bit PRNG (mulberry32) — seeds Louvain reproducibly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
