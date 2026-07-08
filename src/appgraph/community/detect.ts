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

// Ported constants from cluster.py — the split/cohesion thresholds.
const MAX_COMMUNITY_FRACTION = 0.25; // communities larger than 25% of the graph get split
const MIN_SPLIT_SIZE = 10; // only split if the community has at least this many nodes
const COHESION_SPLIT_THRESHOLD = 0.05; // re-split communities with cohesion below this
const COHESION_SPLIT_MIN_SIZE = 50; // only cohesion-split large communities
const LOUVAIN_SEED = 0x9e3779b9; // fixed seed → reproducible partitions

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

/** Detect communities. Returns [] for an empty graph. */
export function detectCommunities(graph: Graph): Community[] {
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

  // Total order: size desc, then lexical by sorted members → stable ids.
  communities.sort(
    (a, b) => b.length - a.length || sortedJoin(a).localeCompare(sortedJoin(b))
  );

  return communities.map((members, id) => {
    const sorted = [...members].sort();
    return {
      id,
      members: sorted,
      cohesion: cohesion(graph, sorted),
      hubName: hubLabel(graph, sorted),
      sig: memberSig(sorted),
    };
  });
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

/** Highest-degree member, tie-broken by id; named by its file base (sans ext). */
function hubLabel(graph: Graph, members: string[]): string {
  let hub = members[0]!;
  let best = -1;
  for (const n of members) {
    const d = graph.degree(n);
    if (d > best || (d === best && n < hub)) {
      best = d;
      hub = n;
    }
  }
  return basename(hub).replace(/\.[^.]+$/, '') || hub;
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
