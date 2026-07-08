/**
 * L3 · target-side semantic scan.
 *
 * The migration-invariant literals U7 recovered on the source (URLs, route
 * paths, SQL, enum value sets) must survive verbatim on the target. There is no
 * ArkTS grammar to bind them to symbols, so — honestly scoped — we CONTAINS-scan
 * the generated `.ets`/`.ts`/`.json5` text for each value. This is a presence
 * check, not a semantic one: a literal that only appears inside a comment still
 * counts (the same known limitation the capability-marker scan carries). The
 * `depth` a caller reports for these checks is therefore `contains-scan`.
 *
 * Pure over its inputs and deterministic: the index is built once per verify and
 * every scan reads it in a fixed (sorted) file order.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** One indexed target source file (path is target-root-relative, POSIX). */
export interface TargetSourceFile {
  path: string;
  content: string;
  /** `content` with every whitespace run folded to a single space (for SQL). */
  normalized: string;
}

export interface TargetSourceIndex {
  root: string;
  files: TargetSourceFile[];
}

const SCANNED_EXTENSIONS = ['.ets', '.ts', '.json5'];

/**
 * Load the full text of every target `.ets`/`.ts`/`.json5` file. When
 * `pathPrefixes` is given (ledger target paths, POSIX, root-relative), only
 * files under one of those prefixes are indexed — the per-unit scope.
 */
export function loadTargetSources(targetRoot: string, pathPrefixes?: string[]): TargetSourceIndex {
  const prefixes = pathPrefixes && pathPrefixes.length > 0 ? pathPrefixes : null;
  const files: TargetSourceFile[] = [];
  for (const full of walkScannableFiles(targetRoot)) {
    const rel = relative(targetRoot, full).split(sep).join('/');
    if (prefixes && !prefixes.some((p) => rel === p || rel.startsWith(p.endsWith('/') ? p : p + '/'))) {
      continue;
    }
    let content: string;
    try {
      content = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    files.push({ path: rel, content, normalized: content.replace(/\s+/g, ' ') });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { root: targetRoot, files };
}

/** Contains-scan for a literal value; returns the files it appears in (sorted). */
export function scanLiteral(index: TargetSourceIndex, value: string): { hit: boolean; files: string[] } {
  if (value === '') return { hit: false, files: [] };
  const files = index.files.filter((f) => f.content.includes(value)).map((f) => f.path);
  return { hit: files.length > 0, files };
}

/** Contains-scan for a SQL statement after folding whitespace on both sides. */
export function scanSql(index: TargetSourceIndex, sql: string): { hit: boolean; files: string[] } {
  const needle = sql.replace(/\s+/g, ' ').trim();
  if (needle === '') return { hit: false, files: [] };
  const files = index.files.filter((f) => f.normalized.includes(needle)).map((f) => f.path);
  return { hit: files.length > 0, files };
}

/** Word-boundary scan for a set of enum values; splits into present/missing. */
export function scanEnumValues(
  index: TargetSourceIndex,
  values: string[]
): { present: string[]; missing: string[] } {
  const present: string[] = [];
  const missing: string[] = [];
  for (const value of values) {
    const re = new RegExp(`\\b${escapeRegExp(value)}\\b`);
    if (index.files.some((f) => re.test(f.content))) present.push(value);
    else missing.push(value);
  }
  return { present: present.sort(), missing: missing.sort() };
}

const STATE_PATTERN_RE = /@State\b|@Observed\b|@Track\b|AppStorage\b/g;

/** Advisory count of ArkUI reactive-state markers across the target (D3, info). */
export function countStatePatterns(index: TargetSourceIndex): number {
  let count = 0;
  for (const f of index.files) count += (f.content.match(STATE_PATTERN_RE) ?? []).length;
  return count;
}

function walkScannableFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules' || entry.name === 'oh_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (SCANNED_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) out.push(full);
    }
  };
  walk(root);
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
