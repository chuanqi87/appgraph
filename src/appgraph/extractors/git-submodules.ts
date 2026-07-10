/**
 * Deterministic `.gitmodules` → vendored submodule path extractor.
 *
 * A repo-root `.gitmodules` declares every git submodule vendored into the tree
 * (e.g. shadowsocks-android vendors `shadowsocks-rust`). Those paths are usually
 * third-party dependency source, not the app's own code, so they inflate the
 * code graph when indexed as app code. This helper recovers the declared paths;
 * a caller can feed them into an ignore matcher to skip them.
 *
 * NOTE (P3.4): this helper is intentionally standalone. It is NOT yet wired into
 * the upstream `buildDefaultIgnore` default-ignore set: doing so would change
 * GLOBAL codegraph indexing behavior for every project and language (not only
 * Android), takes effect only after a re-index, and risks excluding a submodule
 * that genuinely IS app code. Wiring is deferred to a future appgraph-scoped
 * ignore hook so this exclusion stays opt-in and platform-scoped.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Parse a `.gitmodules` file body into its declared submodule paths (the
 * `path = …` under each `[submodule "…"]` section). Windows-style separators are
 * normalized to posix. Result is sorted + deduped for determinism.
 */
export function parseGitmodulesPaths(source: string): string[] {
  const paths = new Set<string>();
  for (const line of source.split(/\r?\n/)) {
    const m = /^\s*path\s*=\s*(.+?)\s*$/.exec(line);
    if (m && m[1]) paths.add(m[1].replace(/\\/g, '/').replace(/\/+$/, ''));
  }
  return [...paths].sort();
}

/** Read + parse the repo-root `.gitmodules`, or `[]` when it's absent/unreadable. */
export function readGitmodulesPaths(root: string): string[] {
  try {
    return parseGitmodulesPaths(readFileSync(join(root, '.gitmodules'), 'utf8'));
  } catch {
    return [];
  }
}
