/**
 * P1-3b · LLM label sidecar — the CONTROLLED write-back channel.
 *
 * appgraph's graph is deterministic and must stay so (the fingerprint covers it).
 * Semantic labels are inherently non-deterministic (an LLM wrote them), so they
 * live HERE — `.migration/labels.json`, a sidecar keyed by Feature sig / unit id
 * — never in the graph nodes' identity or attrs. The read tools merge them in
 * for DISPLAY only.
 *
 * The calling AI runs the analysis (a dedicated sub-agent) and writes results
 * back through the `migrate_label` MCP tool (or the `migrate label` CLI, same
 * handler), which routes every write through `validateLabel`. The gate is kept
 * DELIBERATELY LIGHT — it only rejects what would actually break the sidecar
 * (empty content, unbounded length, raw control bytes, or a target that doesn't
 * resolve) — not stylistic constraints. `summary` may span multiple lines: a
 * short paragraph of functional + migration notes reads better than one
 * run-on sentence.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson } from '../appgraph/serialize';

export const LABELS_SCHEMA_VERSION = 1;

/** Quality bounds — enforced on every write. */
export const LABEL_NAME_MAX = 60;
export const LABEL_SUMMARY_MAX = 2000;

export interface LabelEntry {
  /** Optional short single-line semantic name (≤ LABEL_NAME_MAX). */
  name?: string;
  /** Functional + migration-notes description (1..LABEL_SUMMARY_MAX); multi-line OK. */
  summary: string;
  /** Always 'llm' — the provenance marker (this store never holds derived facts). */
  provenance: 'llm';
  updatedAt: string;
}

export interface LabelStore {
  schemaVersion: number;
  /** Feature sig → label. */
  features: Record<string, LabelEntry>;
  /** Unit id → label. */
  units: Record<string, LabelEntry>;
}

export function emptyLabelStore(): LabelStore {
  return { schemaVersion: LABELS_SCHEMA_VERSION, features: {}, units: {} };
}

export function readLabelStore(path: string): LabelStore | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LabelStore;
  } catch {
    return null;
  }
}

export function writeLabelStore(path: string, store: LabelStore): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, canonicalJson(store) + '\n', 'utf8');
}

export interface LabelInput {
  name?: string;
  summary: string;
}

/**
 * Light quality gate. Returns the normalized entry, or an error MESSAGE (the
 * caller surfaces it as success-shaped guidance — a rejected write is
 * "fix your input", never a server malfunction). Rejects only what would
 * break the sidecar or its display: empty/whitespace summary, over-length
 * name/summary, and raw control bytes other than newline/tab in `summary`
 * (newline/tab ARE allowed there — a multi-line analysis is fine). `name`
 * stays a single-line short title, so it rejects newlines/tabs too.
 */
export function validateLabel(input: LabelInput): { entry: LabelEntry } | { error: string } {
  const summary = (input.summary ?? '').trim();
  if (summary.length === 0) return { error: 'summary 为空,未写入(需功能描述)。' };
  if (summary.length > LABEL_SUMMARY_MAX) {
    return { error: `summary 长度 ${summary.length} 超过上限 ${LABEL_SUMMARY_MAX},未写入(请精简)。` };
  }
  if (hasDisallowedControlChar(summary, { allowNewline: true })) {
    return { error: 'summary 含不可见控制字符,未写入。' };
  }

  let name: string | undefined;
  if (input.name !== undefined) {
    name = input.name.trim();
    if (name.length === 0) name = undefined;
    else if (name.length > LABEL_NAME_MAX) {
      return { error: `name 长度 ${name.length} 超过上限 ${LABEL_NAME_MAX},未写入。` };
    } else if (hasDisallowedControlChar(name)) {
      return { error: 'name 含换行/控制字符,未写入(须为单行短标题)。' };
    }
  }

  return {
    entry: {
      ...(name ? { name } : {}),
      summary,
      provenance: 'llm',
      updatedAt: new Date().toISOString(),
    },
  };
}

/**
 * True if the string carries a control byte that has no business in a label —
 * everything C0/C1 except (optionally) newline/tab, which a multi-line
 * `summary` is now allowed to use.
 */
function hasDisallowedControlChar(s: string, opts: { allowNewline?: boolean } = {}): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (opts.allowNewline && (c === 0x0a || c === 0x09)) continue;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}
