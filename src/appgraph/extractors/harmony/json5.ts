/**
 * JSON5 reader for HarmonyOS build/config files, with a hard anti-silence contract.
 *
 * hvigor's config files (`build-profile.json5`, `oh-package.json5`,
 * `module.json5`, `app.json5`) are JSON5, not JSON: measured over 5,041 real
 * files, 40% fail `JSON.parse` — comments and trailing commas dominate, but
 * single-quoted strings and unquoted keys appear too (in `oh-package.json5`
 * dependency blocks specifically, i.e. exactly where the module dependency edges
 * live).
 *
 * THE CONTRACT: a caller must never receive a result that *looks* complete when
 * it isn't. The bug this module exists to prevent is real and shipped —
 * `resolution/workspace-packages.ts` called `jsonc-parser.parse()` without an
 * errors array, so a file with an unquoted key returned `{dependencies: {}}`
 * instead of failing, and 102 modules' dependencies vanished with no signal.
 * Hence `Json5Result.issues`: non-empty means "these facts are incomplete", and
 * every caller must turn that into a coverageWarning.
 *
 * Strategy: `json5` handles the full grammar. On the rare unparseable file we
 * still fall back to `jsonc-parser`'s error-recovering parse to salvage a
 * partial object — but that partial value ALWAYS arrives with `issues` set, so
 * it is reported rather than trusted.
 *
 * NOTE: `resources/**` files (`string.json`, `route_map.json`, `main_pages.json`,
 * `form_config.json`) are standard JSON — use `JSON.parse`, not this module.
 */

import { readFileSync } from 'node:fs';
import JSON5 from 'json5';
import { parse as parseJsonc, printParseErrorCode, type ParseError } from 'jsonc-parser';

export interface Json5Issue {
  kind: 'parse' | 'read';
  message: string;
  offset?: number;
}

export interface Json5Result {
  /** Parsed value, or null. NEVER trust this without checking `issues` first. */
  value: unknown;
  /** Non-empty ⇒ facts are incomplete; the caller MUST emit a coverageWarning. */
  issues: Json5Issue[];
  /** True when the strict parse failed and a partial recovery was used. */
  degraded: boolean;
}

/** Parse JSON5 text. Strict first; error-recovering salvage only on failure. */
export function parseJson5(text: string): Json5Result {
  try {
    return { value: JSON5.parse(text), issues: [], degraded: false };
  } catch (err) {
    return salvage(text, err);
  }
}

/** Read + parse a JSON5 file. Unreadable files yield a `read` issue, not a throw. */
export function readJson5(absPath: string): Json5Result {
  let text: string;
  try {
    text = readFileSync(absPath, 'utf8');
  } catch (err) {
    return {
      value: null,
      issues: [{ kind: 'read', message: err instanceof Error ? err.message : String(err) }],
      degraded: false,
    };
  }
  return parseJson5(text);
}

/**
 * Best-effort partial recovery after a strict-parse failure.
 *
 * `jsonc-parser` recovers around bad tokens, so a file with one malformed entry
 * still yields the rest. That salvage is worth having — but it is only ever
 * returned WITH issues attached, so no caller can mistake it for a clean parse.
 */
function salvage(text: string, strictError: unknown): Json5Result {
  const issues: Json5Issue[] = [
    {
      kind: 'parse',
      message: strictError instanceof Error ? strictError.message : String(strictError),
    },
  ];

  const jsoncErrors: ParseError[] = [];
  let recovered: unknown = null;
  try {
    recovered = parseJsonc(text, jsoncErrors, {
      allowTrailingComma: true,
      disallowComments: false,
    });
  } catch {
    // Recovery itself failed — the strict error already describes the problem.
  }
  for (const e of jsoncErrors.slice(0, 5)) {
    issues.push({
      kind: 'parse',
      message: `${printParseErrorCode(e.error)} @${e.offset}`,
      offset: e.offset,
    });
  }

  return { value: recovered ?? null, issues, degraded: true };
}

/** Convenience: the parsed value as a plain object, or null when it isn't one. */
export function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Convenience: the parsed value as an array, or [] when it isn't one. */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Convenience: a string field, or undefined when absent/not a string. */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
