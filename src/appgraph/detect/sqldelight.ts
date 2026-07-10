/**
 * U3b · SQL-defined data models — SQLDelight `.sq` tables + handwritten SQLite.
 *
 * The primary-constructor entity pass (`entities.ts`) only sees Kotlin/Java
 * *classes*. Two big data-layer families live outside the symbol graph entirely:
 *
 *   1. SQLDelight schemas — `CREATE TABLE` lives in `*.sq` files, which codegraph
 *      never indexes, so an SQLDelight-backed app (CatchUp) had ZERO data models.
 *      We walk the filesystem (like `resources.ts`) and parse each `CREATE TABLE`
 *      deterministically into a `DataModel` node (subtype `sqldelight-table`),
 *      carrying the SAME `FieldSchema` structure as a Room entity so V2's
 *      field-level diff and the RDB-table brief work identically.
 *
 *   2. Handwritten SQLite — a `SQLiteOpenHelper` builds its `CREATE TABLE` strings
 *      by concatenating `KEY_*`/`TABLE_NAME_*` constants (AntennaPod's
 *      `PodDBAdapter`). That is NOT a statically-evaluable literal, so forcing a
 *      typed schema out of it would be guesswork. Instead we emit a per-module
 *      BRIEF HINT (table names + the resolvable column-key inventory) and NO
 *      `DataModel` node — a heuristic hint never enters the V2 entity diff, so it
 *      can't manufacture a false migration gap for an already-migrated project.
 *
 * Everything here is PURE + DETERMINISTIC: files sorted, ids content-derived,
 * caps on table/column counts, no line numbers.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  AppEdge,
  AppNode,
  CoverageWarning,
  dataModelMatchKey,
  makeEdgeId,
  makeNodeId,
} from '../schema';
import { Node } from '../../types';
import type { FieldSchema } from './entities';
import { KotlinConstant, topLevelConstants } from './kotlin-source';
import { javaStaticFinalConstants } from './java-source';
import { attributeModule, ModuleRef, moduleDirIndex } from './manifest-capabilities';
import { DetectContext, isShippableJvmNode, ReadCode } from './shared';

/** Directories that never hold shippable `.sq` schema. */
const EXCLUDED_DIRS = new Set([
  'build',
  '.git',
  '.gradle',
  '.idea',
  'node_modules',
  '.appgraph',
  '.codegraph',
  '.migration',
]);
const TEST_PATH_RE = /\/src\/[^/]*test[^/]*\//i;

// -- Caps (bounded output, stable) --
/** Max tables kept per project / class (rest elided). */
const MAX_TABLES = 300;
/** Max columns kept per table (rest elided). */
const MAX_COLUMNS = 300;
/** Max resolvable column-key names kept per handwritten-SQLite module hint. */
const MAX_KEY_COLUMNS = 200;

/** One `CREATE TABLE` parsed into a name + normalized field schema. */
export interface ParsedTable {
  name: string;
  fields: FieldSchema[];
}

// ===========================================================================
// 1 · Pure SQL `CREATE TABLE` parser (shared by both families)
// ===========================================================================

/**
 * Parse every `CREATE TABLE <name> (...)` in a SQL string into its column
 * schema. Understands SQLDelight's `AS <KotlinType>` column adapters, inline +
 * table-level `PRIMARY KEY`, `NOT NULL`, `DEFAULT`, and `--` / `/* *\/`
 * comments. Statements that are not `CREATE TABLE` (inserts, selects, indexes,
 * `import` lines) are ignored. Pure + deterministic.
 */
export function parseCreateTables(sql: string): ParsedTable[] {
  const clean = blankSqlComments(sql);
  const tables: ParsedTable[] = [];
  const re =
    /\bCREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"[]?[A-Za-z_][\w$]*[`"\]]?)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null && tables.length < MAX_TABLES) {
    const name = stripSqlQuotes(m[1]!);
    const open = re.lastIndex - 1; // index of the `(`
    const close = matchParen(clean, open);
    if (close === -1) continue;
    const fields = parseTableBody(clean.slice(open + 1, close));
    if (name && fields.length > 0) tables.push({ name, fields });
    re.lastIndex = close + 1;
  }
  return tables;
}

/** Split a table body into columns + apply table-level PRIMARY KEY constraints. */
function parseTableBody(body: string): FieldSchema[] {
  const fields: FieldSchema[] = [];
  const tablePk = new Set<string>();
  for (const seg of splitTopLevelCommas(body)) {
    const s = seg.trim();
    if (!s) continue;
    const constraintCols = tableConstraintPkColumns(s);
    if (constraintCols) {
      for (const c of constraintCols) tablePk.add(c.toLowerCase());
      continue;
    }
    if (isTableConstraint(s)) continue; // FOREIGN KEY / UNIQUE / CHECK / CONSTRAINT
    const field = parseColumn(s);
    if (field && fields.length < MAX_COLUMNS) fields.push(field);
  }
  for (const f of fields) {
    if (tablePk.has(f.name.toLowerCase())) f.primaryKey = true;
  }
  return fields;
}

/** Parse one column definition (`timestamp INTEGER AS Instant NOT NULL`). */
function parseColumn(seg: string): FieldSchema | null {
  const nameM = /^([`"[]?[A-Za-z_][\w$]*[`"\]]?)\s+(.*)$/s.exec(seg);
  if (!nameM) return null;
  const name = stripSqlQuotes(nameM[1]!);
  if (!name) return null;
  const rest = nameM[2]!;
  const sqlTypeM = /^([A-Za-z]+)(?:\s*\([^)]*\))?/.exec(rest);
  const sqlType = sqlTypeM ? sqlTypeM[1]! : 'TEXT';
  const asM = /\bAS\s+([A-Za-z_][\w.]*(?:<[^)]*>)?)/i.exec(rest);
  const type = asM ? asM[1]!.trim() : sqlType.toUpperCase();
  const notNull = /\bNOT\s+NULL\b/i.test(rest);
  const primaryKey = /\bPRIMARY\s+KEY\b/i.test(rest);
  return {
    name,
    type,
    nullable: !notNull && !primaryKey,
    primaryKey,
    hasDefault: /\bDEFAULT\b/i.test(rest),
  };
}

/** `PRIMARY KEY(a, b)` (table-level) → its column names, else null. */
function tableConstraintPkColumns(seg: string): string[] | null {
  const m = /^PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(seg);
  if (!m) return null;
  return m[1]!
    .split(',')
    .map((c) => stripSqlQuotes(c.trim().split(/\s+/)[0] ?? ''))
    .filter((c) => c.length > 0);
}

/** A table-level constraint segment (not a column). */
function isTableConstraint(seg: string): boolean {
  return /^(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|CONSTRAINT)\b/i.test(seg);
}

/** Blank `--` line and `/* *\/` block comments to spaces (keeps offsets). */
function blankSqlComments(sql: string): string {
  const out = sql.split('');
  const n = sql.length;
  let i = 0;
  while (i < n) {
    if (sql[i] === '-' && sql[i + 1] === '-') {
      let j = i;
      while (j < n && sql[j] !== '\n') out[j++] = ' ';
      i = j;
    } else if (sql[i] === '/' && sql[i + 1] === '*') {
      let j = i;
      while (j < n && !(sql[j] === '*' && sql[j + 1] === '/')) out[j++] = ' ';
      if (j < n) {
        out[j++] = ' ';
        out[j++] = ' ';
      }
      i = j;
    } else {
      i++;
    }
  }
  return out.join('');
}

/** Matching `)` for the `(` at `openIdx` (balanced), or -1. */
function matchParen(text: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split on commas at paren-depth 0 (so a `NUMERIC(10,2)` type isn't split). */
function splitTopLevelCommas(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= body.length; i++) {
    const c = body[i];
    if (i === body.length || (c === ',' && depth === 0)) {
      out.push(body.slice(start, i));
      start = i + 1;
    } else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
  }
  return out;
}

/** Strip surrounding `` ` ``/`"`/`[ ]` identifier quotes. */
function stripSqlQuotes(raw: string): string {
  return raw.replace(/^[`"[]/, '').replace(/[`"\]]$/, '').trim();
}

// ===========================================================================
// 2 · SQLDelight `.sq` → DataModel nodes (filesystem-driven)
// ===========================================================================

export interface SqlDelightResult {
  dataModelNodes: AppNode[];
  containsEdges: AppEdge[];
  warnings: CoverageWarning[];
  stats: { sqFiles: number; tables: number };
}

/** Detect SQLDelight `.sq` schemas under `projectRoot` as DataModel nodes. */
export function detectSqlDelightModels(projectRoot: string, modules: ModuleRef[] = []): SqlDelightResult {
  const dirIndex = moduleDirIndex(modules);
  const byMatchKey = new Map<string, AppNode>();
  const containsById = new Map<string, AppEdge>();
  const warnings: CoverageWarning[] = [];
  let sqFiles = 0;
  let tables = 0;

  for (const abs of findSqFiles(projectRoot)) {
    const relPath = toPosix(relative(projectRoot, abs));
    let source: string;
    try {
      source = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    sqFiles++;
    const owner = attributeModule(relPath, dirIndex);
    for (const table of parseCreateTables(source)) {
      tables++;
      const matchKey = dataModelMatchKey(table.name);
      if (byMatchKey.has(matchKey)) continue; // stable: first file (sorted) wins
      const id = makeNodeId('android', 'DataModel', matchKey);
      byMatchKey.set(matchKey, {
        id,
        kind: 'DataModel',
        matchKey,
        name: table.name,
        platform: 'android',
        subtype: 'sqldelight-table',
        provenance: 'source-static',
        fidelity: 'source-project',
        confidence: 0.9,
        platformRef: { file: relPath },
        attrs: {
          framework: 'sqldelight',
          tableName: table.name,
          fieldCount: table.fields.length,
          fields: table.fields,
        },
      });
      if (owner) {
        const edgeId = makeEdgeId('app_contains', owner.id, id);
        if (!containsById.has(edgeId)) {
          containsById.set(edgeId, {
            id: edgeId,
            kind: 'app_contains',
            from: owner.id,
            to: id,
            provenance: 'source-static',
            confidence: 0.85,
            attrs: { kind: 'datamodel' },
          });
        }
      }
    }
  }

  return {
    dataModelNodes: [...byMatchKey.values()].sort((a, b) => a.id.localeCompare(b.id)),
    containsEdges: [...containsById.values()].sort((a, b) => a.id.localeCompare(b.id)),
    warnings,
    stats: { sqFiles, tables },
  };
}

/** Every shippable `*.sq` file (test source sets + build output excluded). */
function findSqFiles(root: string): string[] {
  const out: string[] = [];
  const walkDir = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) walkDir(full);
      } else if (entry.name.endsWith('.sq')) {
        if (!TEST_PATH_RE.test(toPosix(full))) out.push(full);
      }
    }
  };
  walkDir(root);
  return out.sort();
}

// ===========================================================================
// 3 · Handwritten SQLite → per-module BRIEF HINT (no DataModel node)
// ===========================================================================

/** A handwritten-SQLite persistence layer found in one module (heuristic hint). */
export interface SqliteSchemaHint {
  /** Table names resolved from `CREATE TABLE …` (best-effort). */
  tables: string[];
  /** Resolvable column-key names (`KEY_*`/`COLUMN_*` constant values). */
  columns: string[];
  /** True when the column list was truncated by the cap. */
  columnsTruncated?: boolean;
  /** Source file anchors of the owner class(es). */
  files: string[];
}

export interface SqliteHintResult {
  hintsByModule: Map<string, SqliteSchemaHint>;
  stats: { ownerClasses: number; modulesWithHint: number };
}

/**
 * Detect handwritten-SQLite persistence classes (a `SQLiteOpenHelper` /
 * `SQLiteDatabase` user with `CREATE TABLE` strings) and emit a per-module hint:
 * the table names + the resolvable column-key inventory. Deliberately produces
 * NO `DataModel` node — the schema is assembled from `KEY_*`/`TABLE_NAME_*`
 * concatenations that can't be statically evaluated, so a fabricated schema
 * would be guesswork AND would enter V2's entity diff as a false gap.
 */
export function detectSqliteSchemaHints(
  nodes: Node[],
  readCode: ReadCode,
  ctx: DetectContext
): SqliteHintResult {
  const hintsByModule = new Map<string, SqliteSchemaHint>();
  let ownerClasses = 0;

  const classes = [...nodes]
    .filter((n) => n.kind === 'class' && isShippableJvmNode(n))
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const node of classes) {
    const moduleId = ctx.nodeToModuleId.get(node.id);
    if (!moduleId) continue;
    const code = readCode(node);
    if (code === null || !isSqliteSchemaOwner(code)) continue;
    ownerClasses++;

    const constMap = stringConstMap(node, code);
    const tables = resolveCreateTableNames(code, constMap);
    const columns = keyColumnValues(constMap);
    if (tables.length === 0 && columns.length === 0) continue;

    const hint = hintsByModule.get(moduleId) ?? { tables: [], columns: [], files: [] };
    hint.tables = [...new Set([...hint.tables, ...tables])].sort();
    hint.columns = [...new Set([...hint.columns, ...columns])].sort();
    if (!hint.files.includes(node.filePath)) hint.files.push(node.filePath);
    hint.files.sort();
    hintsByModule.set(moduleId, hint);
  }

  for (const [moduleId, hint] of hintsByModule) {
    if (hint.columns.length > MAX_KEY_COLUMNS) {
      hint.columns = hint.columns.slice(0, MAX_KEY_COLUMNS);
      hint.columnsTruncated = true;
    }
    hintsByModule.set(moduleId, hint);
  }

  return { hintsByModule, stats: { ownerClasses, modulesWithHint: hintsByModule.size } };
}

/** A class that builds SQLite schema: uses the SQLite APIs AND has CREATE TABLE. */
function isSqliteSchemaOwner(code: string): boolean {
  if (!/\bCREATE\s+TABLE\b/i.test(code)) return false;
  return /\bSQLiteOpenHelper\b/.test(code) || /\bSQLiteDatabase\b/.test(code);
}

/** Local `static final String NAME = "value"` / Kotlin `const val` string map. */
function stringConstMap(node: Node, code: string): Map<string, string> {
  const consts: KotlinConstant[] =
    node.language === 'java' ? javaStaticFinalConstants(code) : topLevelConstants(code);
  const map = new Map<string, string>();
  for (const c of consts) {
    if (c.valueKind === 'string') map.set(c.name, c.value);
  }
  return map;
}

/**
 * Table names from each `CREATE TABLE …`. The name is either inline
 * (`CREATE TABLE Feeds (`) or the first constant reference after the literal
 * (`"CREATE TABLE " + TABLE_NAME_FEEDS`), resolved via the local constant map.
 */
function resolveCreateTableNames(code: string, constMap: Map<string, string>): string[] {
  const names = new Set<string>();
  const re = /CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/gi;
  while (re.exec(code) !== null) {
    const rest = code.slice(re.lastIndex);
    // Inline `Foo (` or concat boundary `" + IDENT`.
    const idM = /^["`[]?\s*\+?\s*([`"[]?)([A-Za-z_][\w$]*)/.exec(rest);
    if (!idM) continue;
    const raw = idM[2]!;
    names.add(constMap.get(raw) ?? raw);
  }
  return [...names].sort();
}

/** Resolvable column names — values of `KEY_*`/`COLUMN_*`/`COL_*` string constants. */
function keyColumnValues(constMap: Map<string, string>): string[] {
  const cols = new Set<string>();
  for (const [name, value] of constMap) {
    if (/^(KEY|COLUMN|COL)_/.test(name) && /^[A-Za-z_][\w]*$/.test(value)) cols.add(value);
  }
  return [...cols].sort();
}

// ===========================================================================
// helpers
// ===========================================================================

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}
