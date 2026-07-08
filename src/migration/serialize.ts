/**
 * On-disk persistence for a MigrationGraph.
 *
 * Deterministic serialization primitives (canonical JSON + content hash) live in
 * the platform-neutral `appgraph/serialize.ts`; this module layers the
 * MigrationGraph-specific path resolution and read/write on top so two runs over
 * unchanged source produce an identical file and identical hash.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalJson, contentHash } from '../appgraph/serialize';
import { getMigrationDir } from './paths';
import { MigrationGraph } from './types';

/** Serialize with recursively sorted object keys so output is order-stable. */
export function serializeMigrationGraph(graph: MigrationGraph): string {
  return canonicalJson(graph);
}

/** SHA-256 of the canonical serialization — the determinism fingerprint. */
export function hashMigrationGraph(graph: MigrationGraph): string {
  return contentHash(graph);
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
