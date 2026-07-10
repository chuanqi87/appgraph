/**
 * U7 · semantic constants — the L3 migration-invariant literals.
 *
 * A platform translation must PRESERVE certain literal values verbatim: base
 * URLs, Retrofit route paths, Room SQL, and enum value sets are contracts with
 * the outside world (servers, on-disk schemas, wire formats) that survive the
 * Kotlin→ArkTS rewrite unchanged. This pass recovers them from source spans so
 * the plan can state them as acceptance truth and `verify` can scan for them.
 *
 * Everything here is PURE and DETERMINISTIC: same nodes/source in → same facts
 * out. Values are recovered by the `kotlin-source` primitives (which slice the
 * original code, since sanitization blanks literal contents).
 */

import { CoverageWarning } from '../schema';
import { Node } from '../../types';
import { annotationPositionalArg, enumEntries, topLevelConstants } from './kotlin-source';
import { javaStaticFinalConstants } from './java-source';
import { DetectContext, isShippableJvmNode, ReadCode } from './shared';

/** Migration-invariant literals recovered from one ArchModule (attached to attrs). */
export interface ConstantsFacts {
  /** Named `const val` string/number literals (URLs tagged `url`). */
  literals: Array<{ name: string; value: string; kind: 'string' | 'number' | 'url'; file: string }>;
  /** Retrofit route declarations (`@GET`/`@POST`/…). */
  routes: Array<{ method: string; path: string; file: string }>;
  /** Room `@Query` SQL statements (`truncated: true` when clipped at MAX_SQL_LEN). */
  queries: Array<{ sql: string; file: string; truncated?: boolean }>;
  /** `enum class` value sets. */
  enums: Array<{ name: string; values: string[]; file: string }>;
}

export interface ConstantsResult {
  constantsByModule: Map<string, ConstantsFacts>;
  warnings: CoverageWarning[];
  stats: { modulesWithConstants: number; literals: number; routes: number; queries: number; enums: number };
}

const METHOD_KINDS = new Set(['method', 'function']);
const ENUM_KINDS = new Set(['class', 'enum']);
/** Java node kinds a `static final` constant field surfaces as (extractor-dependent). */
const CONSTANT_KINDS = new Set(['constant', 'field']);
const HTTP_VERBS = ['DELETE', 'GET', 'PATCH', 'POST', 'PUT'];
const SQL_PREFIX = /^\s*(select|insert|update|delete|with)\b/i;

/** Per-module caps (deterministic truncation, warned on overflow). */
const MAX_LITERALS = 50;
const MAX_ENUM_VALUES = 64;
const MAX_SQL_LEN = 500;

/** Detect the migration-invariant literals of every module. */
export function detectConstants(nodes: Node[], readCode: ReadCode, ctx: DetectContext): ConstantsResult {
  const facts = new Map<string, ConstantsFacts>();
  const warnings: CoverageWarning[] = [];

  const factsFor = (moduleId: string): ConstantsFacts => {
    let f = facts.get(moduleId);
    if (!f) {
      f = { literals: [], routes: [], queries: [], enums: [] };
      facts.set(moduleId, f);
    }
    return f;
  };

  const sorted = [...nodes].filter(isShippableJvmNode).sort((a, b) => a.id.localeCompare(b.id));
  for (const node of sorted) {
    const moduleId = ctx.nodeToModuleId.get(node.id);
    if (!moduleId) continue;
    const code = readCode(node);
    if (code === null) continue;
    const file = node.filePath;

    if (node.language === 'kotlin' && code.includes('const val')) {
      const f = factsFor(moduleId);
      for (const c of topLevelConstants(code)) {
        const lit = classifyLiteral(c);
        if (lit) f.literals.push({ ...lit, file });
      }
    } else if (
      node.language === 'java' &&
      CONSTANT_KINDS.has(node.kind) &&
      code.includes('static final')
    ) {
      // Java has no `const val`: its migration-invariant literals are class-scope
      // `static final` fields (AntennaPod's `PodDBAdapter.KEY_* = "column"`), each
      // extracted as its own constant/field node. Same literals structure + noise
      // rules + MAX_LITERALS cap as the Kotlin path (P3.2a).
      const f = factsFor(moduleId);
      for (const c of javaStaticFinalConstants(code)) {
        const lit = classifyLiteral(c);
        if (lit) f.literals.push({ ...lit, file });
      }
    }
    if (METHOD_KINDS.has(node.kind)) {
      for (const verb of HTTP_VERBS) {
        if (!code.includes('@' + verb)) continue;
        const path = annotationPositionalArg(code, verb);
        if (path !== null) factsFor(moduleId).routes.push({ method: verb, path, file });
      }
      if (code.includes('@Query')) {
        const sql = annotationPositionalArg(code, 'Query');
        if (sql !== null && SQL_PREFIX.test(sql)) {
          const trimmed = sql.trim();
          const clipped = trimmed.length > MAX_SQL_LEN;
          // `truncated` is additive/back-compat (present only when true): the plan
          // layer reads it to down-grade the SQL-preservation L3 check to info,
          // since a clipped statement can't be a byte-exact acceptance invariant.
          factsFor(moduleId).queries.push({
            sql: trimmed.slice(0, MAX_SQL_LEN),
            file,
            ...(clipped ? { truncated: true } : {}),
          });
        }
      }
    }
    if (ENUM_KINDS.has(node.kind) && code.includes('enum class')) {
      const values = enumEntries(code);
      if (values.length > 0) {
        factsFor(moduleId).enums.push({ name: node.name, values: values.slice(0, MAX_ENUM_VALUES), file });
      }
    }
  }

  for (const [moduleId, f] of facts) facts.set(moduleId, normalize(f, ctx, moduleId, warnings));

  let literals = 0;
  let routes = 0;
  let queries = 0;
  let enums = 0;
  for (const f of facts.values()) {
    literals += f.literals.length;
    routes += f.routes.length;
    queries += f.queries.length;
    enums += f.enums.length;
  }
  return {
    constantsByModule: facts,
    warnings,
    stats: { modulesWithConstants: facts.size, literals, routes, queries, enums },
  };
}

/** Apply the noise rules to one `const val` literal, or drop it. */
function classifyLiteral(
  c: { name: string; value: string; valueKind: 'string' | 'number' }
): { name: string; value: string; kind: 'string' | 'number' | 'url' } | null {
  if (c.valueKind === 'number') {
    const t = c.value.trim();
    if (t === '0' || t === '1' || t === '-1') return null;
    return { name: c.name, value: t, kind: 'number' };
  }
  const t = c.value.trim();
  if (/^https?:\/\//i.test(t)) return { name: c.name, value: t, kind: 'url' };
  if (t.length < 4) return null;
  if (/^\d+$/.test(t)) return null; // pure digits
  if (/^[\p{P}\p{S}\s]+$/u.test(t)) return null; // pure punctuation/whitespace
  return { name: c.name, value: c.value, kind: 'string' };
}

/** Dedup + sort + cap one module's facts; emit a truncation warning per cap hit. */
function normalize(
  f: ConstantsFacts,
  ctx: DetectContext,
  moduleId: string,
  warnings: CoverageWarning[]
): ConstantsFacts {
  const moduleName = ctx.moduleNameById.get(moduleId) ?? moduleId;

  // literals: dedup by value (keep the lexicographically smallest name), sort, cap.
  const byValue = new Map<string, { name: string; value: string; kind: 'string' | 'number' | 'url'; file: string }>();
  for (const lit of f.literals) {
    const prev = byValue.get(lit.value);
    if (!prev || lit.name.localeCompare(prev.name) < 0) byValue.set(lit.value, lit);
  }
  let literals = [...byValue.values()].sort(
    (a, b) => a.value.localeCompare(b.value) || a.name.localeCompare(b.name)
  );
  if (literals.length > MAX_LITERALS) {
    warnings.push({ message: `模块 ${moduleName} 语义常量超过 ${MAX_LITERALS} 条,已截断(共 ${literals.length})` });
    literals = literals.slice(0, MAX_LITERALS);
  }

  const routes = [...f.routes].sort(
    (a, b) => a.method.localeCompare(b.method) || a.path.localeCompare(b.path) || a.file.localeCompare(b.file)
  );
  const queries = dedupBy(f.queries, (q) => q.sql).sort(
    (a, b) => a.sql.localeCompare(b.sql) || a.file.localeCompare(b.file)
  );
  const enums = dedupEnums(f.enums);

  return { literals, routes, queries, enums };
}

/**
 * Dedup enums by (sorted value set, file) — the SAME nested enum frequently
 * surfaces under several outer type names (an outer `class`/`sealed` span whose
 * body holds one `enum class` gets that enum's entries attributed under the outer
 * name too, e.g. `Call` and `State` both listing the same 11 values). Keep one
 * stable representative per (values, file): the lexicographically smallest name.
 */
function dedupEnums(
  raw: Array<{ name: string; values: string[]; file: string }>
): Array<{ name: string; values: string[]; file: string }> {
  const byKey = new Map<string, { name: string; values: string[]; file: string }>();
  for (const e of raw) {
    const values = [...e.values].sort();
    const key = `${e.file}\0${values.join('\0')}`;
    const rep = { name: e.name, values, file: e.file };
    const prev = byKey.get(key);
    if (!prev || rep.name.localeCompare(prev.name) < 0) byKey.set(key, rep);
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function dedupBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const item of items) {
    const k = key(item);
    if (!seen.has(k)) seen.set(k, item);
  }
  return [...seen.values()];
}
