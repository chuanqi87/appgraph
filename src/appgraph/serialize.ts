/**
 * Deterministic serialization primitives for AppGraph — platform-neutral.
 *
 * Recursively sorted object keys → byte-stable JSON → a content hash. Two runs
 * over unchanged input must produce an identical string and identical hash — the
 * property that makes an AppGraph a trustworthy fact source and lets incremental
 * paths distinguish real change from noise. Graph-specific persistence (paths,
 * read/write) lives with each consumer (e.g. `migration/serialize.ts`).
 */

import { createHash } from 'node:crypto';

/** Canonical JSON — recursively sorted object keys, byte-stable across runs. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2);
}

/** SHA-256 of the canonical serialization — the determinism fingerprint. */
export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
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
