/**
 * Deterministic serialization + on-disk persistence for a MigrationGraph.
 *
 * Mirrors `appgraph/serialize.ts`: recursively sorted keys → byte-stable JSON →
 * a content hash. Two runs over unchanged source must produce an identical file
 * and identical hash — that is what makes the graph a trustworthy migration fact
 * source and lets the incremental path detect real change vs. noise.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getMigrationDir } from './paths';
import { MigrationGraph } from './types';

/** Canonical JSON — recursively sorted object keys, byte-stable across runs. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2);
}

/** Serialize with recursively sorted object keys so output is order-stable. */
export function serializeMigrationGraph(graph: MigrationGraph): string {
  return canonicalJson(graph);
}

/** SHA-256 of the canonical serialization — the determinism fingerprint. */
export function hashMigrationGraph(graph: MigrationGraph): string {
  return createHash('sha256').update(serializeMigrationGraph(graph)).digest('hex');
}

/** Default on-disk path for a project's migration graph. */
export function migrationGraphPath(projectRoot: string): string {
  return join(getMigrationDir(projectRoot), 'migration-graph.json');
}

/** Persist the graph (creating the `.migration/` dir if needed). */
export function writeMigrationGraph(path: string, graph: MigrationGraph): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeMigrationGraph(graph) + '\n', 'utf8');
}

/** Load a previously-written graph, or null if none exists yet. */
export function readMigrationGraph(path: string): MigrationGraph | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  return JSON.parse(raw) as MigrationGraph;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
