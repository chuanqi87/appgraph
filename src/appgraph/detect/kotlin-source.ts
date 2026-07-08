/**
 * Shared, dependency-free Kotlin source parsing for the U-track detect passes.
 *
 * codegraph's Kotlin extractor does NOT fill `Node.decorators` (phase-1 gap #4),
 * so the semantic passes recover annotations + primary-constructor field schemas
 * straight from the symbol's source span (`reader.getCode` returns the span
 * INCLUDING leading annotations and the whole primary constructor — verified on
 * nowinandroid: a `@Entity data class` node spans `@Entity(` → the closing `)`).
 *
 * Everything here is PURE and DETERMINISTIC: same source in → same facts out.
 * We first blank string/char literals and strip comments (preserving offsets) so
 * that keyword / parenthesis scanning never trips over `X::class`, `"class"`,
 * or a `//` fragment.
 */

/** One property declared in a Kotlin primary constructor (`val`/`var` param). */
export interface KotlinField {
  name: string;
  /** Raw type text with the trailing `?` stripped (e.g. `List<Topic>`). */
  type: string;
  nullable: boolean;
  /** Per-field annotation simple names (e.g. `PrimaryKey`, `ColumnInfo`). */
  annotations: string[];
  hasDefault: boolean;
}

/**
 * Blank the CONTENTS of string/char literals and strip comments, keeping the
 * string length identical so indices computed on the result map back 1:1 onto
 * the original. Quotes/comment delimiters become spaces too.
 */
export function sanitizeKotlin(code: string): string {
  const out = code.split('');
  let i = 0;
  const n = code.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < n) {
    const c = code[i];
    const c2 = code[i + 1];
    if (c === '/' && c2 === '/') {
      let j = i + 2;
      while (j < n && code[j] !== '\n') j++;
      blank(i, j);
      i = j;
    } else if (c === '/' && c2 === '*') {
      let j = i + 2;
      while (j < n && !(code[j] === '*' && code[j + 1] === '/')) j++;
      blank(i, Math.min(n, j + 2));
      i = j + 2;
    } else if (c === '"' && code[i + 1] === '"' && code[i + 2] === '"') {
      // Triple-quoted raw string.
      let j = i + 3;
      while (j < n && !(code[j] === '"' && code[j + 1] === '"' && code[j + 2] === '"')) j++;
      blank(i, Math.min(n, j + 3));
      i = j + 3;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && code[j] !== c) {
        if (code[j] === '\\') j++;
        j++;
      }
      blank(i, Math.min(n, j + 1));
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

/** Index of the matching close bracket for the open bracket at `openIdx`, or -1. */
export function matchBracket(text: string, openIdx: number): number {
  const open = text[openIdx];
  const close = open === '(' ? ')' : open === '<' ? '>' : open === '{' ? '}' : '';
  if (!close) return -1;
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const DECL_KEYWORDS = new Set(['class', 'interface', 'object', 'fun', 'enum']);

/**
 * Offset of the first top-level declaration keyword (`class`/`interface`/
 * `object`/`fun`/`enum`), skipping any leading `@Annotation(...)` blocks and
 * modifier words. -1 if none. Operates on sanitized text.
 */
function declarationKeywordIndex(sanitized: string): number {
  let i = 0;
  const n = sanitized.length;
  while (i < n) {
    const c = sanitized[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '@') {
      i++;
      while (i < n && /[\w.]/.test(sanitized[i]!)) i++;
      while (i < n && /\s/.test(sanitized[i]!)) i++;
      if (sanitized[i] === '(') {
        const close = matchBracket(sanitized, i);
        i = close === -1 ? n : close + 1;
      }
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      let j = i;
      while (j < n && /[\w]/.test(sanitized[j]!)) j++;
      const word = sanitized.slice(i, j);
      if (DECL_KEYWORDS.has(word)) return i;
      i = j; // modifier (data/sealed/internal/…) — keep scanning
      continue;
    }
    i++;
  }
  return -1;
}

/**
 * The simple names of annotations applied to the declaration itself (those
 * appearing before the declaration keyword). `@field:Foo` / `@get:Bar` use-site
 * targets are normalized to `Foo` / `Bar`.
 */
export function leadingAnnotations(code: string): string[] {
  const sanitized = sanitizeKotlin(code);
  const end = declarationKeywordIndex(sanitized);
  const scanEnd = end === -1 ? sanitized.length : end;
  return annotationsIn(code, sanitized, 0, scanEnd);
}

/** Extract annotation simple-names from `code[from..to)`, using sanitized offsets. */
function annotationsIn(code: string, sanitized: string, from: number, to: number): string[] {
  const names: string[] = [];
  let i = from;
  while (i < to) {
    if (sanitized[i] === '@') {
      let j = i + 1;
      while (j < to && /[\w.:]/.test(sanitized[j]!)) j++;
      const raw = code.slice(i + 1, j);
      // strip a use-site target like `field:`/`get:`/`param:`
      const name = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw;
      // strip package qualifier `androidx.room.Entity` → `Entity`
      const simple = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
      if (simple) names.push(simple);
      i = j;
      while (i < to && /\s/.test(sanitized[i]!)) i++;
      if (sanitized[i] === '(') {
        const close = matchBracket(sanitized, i);
        i = close === -1 ? to : close + 1;
      }
    } else {
      i++;
    }
  }
  return names;
}

/**
 * The primary-constructor property fields (only `val`/`var` params — plain
 * params are not persistent state). Returns [] when there is no primary
 * constructor. Handles per-field annotations, generics in the type, nullability,
 * and default values.
 */
export function parsePrimaryConstructor(code: string): KotlinField[] {
  const sanitized = sanitizeKotlin(code);
  const kw = declarationKeywordIndex(sanitized);
  if (kw === -1 || sanitized.slice(kw, kw + 5) !== 'class') return [];

  // Find the primary-constructor `(` after the class name (skip `<…>` type
  // params and an optional `constructor` keyword / its annotations).
  let i = kw + 5;
  const n = sanitized.length;
  while (i < n) {
    const c = sanitized[i]!;
    if (c === '{') return []; // class body reached with no constructor
    if (c === '<') {
      const close = matchBracket(sanitized, i);
      if (close === -1) return [];
      i = close + 1;
      continue;
    }
    if (c === '(') break;
    i++;
  }
  if (i >= n || sanitized[i] !== '(') return [];

  const close = matchBracket(sanitized, i);
  if (close === -1) return [];
  const params = splitTopLevel(sanitized.slice(i + 1, close), i + 1);
  const fields: KotlinField[] = [];
  for (const { start, end } of params) {
    const field = parseParam(code, sanitized, start, end);
    if (field) fields.push(field);
  }
  return fields;
}

/** Split a paren body into top-level comma segments, returned as absolute spans. */
export function splitTopLevel(body: string, offset: number): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= body.length; i++) {
    const c = body[i];
    if (i === body.length || (c === ',' && depth === 0)) {
      if (i > start && body.slice(start, i).trim()) {
        spans.push({ start: offset + start, end: offset + i });
      }
      start = i + 1;
    } else if (c === '(' || c === '<' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === '>' || c === ']' || c === '}') depth--;
  }
  return spans;
}

/** Parse one constructor param span into a field, or null if it is not a property. */
function parseParam(
  code: string,
  sanitized: string,
  start: number,
  end: number
): KotlinField | null {
  const annotations = annotationsIn(code, sanitized, start, end);
  const seg = sanitized.slice(start, end);
  // The param must declare a property (`val`/`var`) to be persistent state.
  const propMatch = /(^|[\s@()])(val|var)\s+([A-Za-z_]\w*)/.exec(seg);
  if (!propMatch) return null;
  const name = propMatch[3]!;
  const afterName = start + propMatch.index + propMatch[0].length;

  // Type is between the first top-level `:` after the name and the `=` (default) or end.
  const colon = indexOfTopLevel(sanitized, ':', afterName, end);
  let type = '';
  let hasDefault = false;
  if (colon !== -1) {
    const eq = indexOfTopLevel(sanitized, '=', colon + 1, end);
    hasDefault = eq !== -1;
    const typeEnd = eq === -1 ? end : eq;
    type = code.slice(colon + 1, typeEnd).trim();
  } else {
    hasDefault = indexOfTopLevel(sanitized, '=', afterName, end) !== -1;
  }
  const nullable = type.endsWith('?');
  if (nullable) type = type.slice(0, -1).trim();
  return { name, type, nullable, annotations, hasDefault };
}

/** First index of `ch` at bracket-depth 0 within `[from,to)`, or -1. */
export function indexOfTopLevel(text: string, ch: string, from: number, to: number): number {
  let depth = 0;
  for (let i = from; i < to; i++) {
    const c = text[i]!;
    if (c === '(' || c === '<' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === '>' || c === ']' || c === '}') depth--;
    else if (c === ch && depth === 0) return i;
  }
  return -1;
}

/**
 * Value of a named argument in an annotation, e.g. `@Entity(tableName = "topics")`
 * → `tableName` → `topics`. Returns null when the annotation or arg is absent.
 * String quotes are stripped; other literals are returned verbatim.
 */
export function annotationArg(code: string, annotation: string, arg: string): string | null {
  const sanitized = sanitizeKotlin(code);
  const re = new RegExp(`@${annotation}\\s*\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(sanitized)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(sanitized, open);
    if (close === -1) continue;
    // Match only up to the `=` — the trailing whitespace can't be `\s*`-consumed
    // here because the string value is blanked to spaces in `sanitized`, so a
    // greedy `\s*` would swallow the value. Skip post-`=` whitespace on the
    // ORIGINAL code, where the value's first char (a quote/digit) is intact.
    const argRe = new RegExp(`(^|[\\s,(])${arg}\\s*=`, 'g');
    const inner = sanitized.slice(open + 1, close);
    const am = argRe.exec(inner);
    if (!am) continue;
    let valStart = open + 1 + am.index + am[0].length;
    while (valStart < close && /\s/.test(code[valStart] ?? '')) valStart++;
    const valEnd = indexOfTopLevelAny(sanitized, [',', ')'], valStart, close + 1);
    return code.slice(valStart, valEnd === -1 ? close : valEnd).trim().replace(/^["']|["']$/g, '');
  }
  return null;
}

function indexOfTopLevelAny(text: string, chars: string[], from: number, to: number): number {
  let depth = 0;
  for (let i = from; i < to; i++) {
    const c = text[i]!;
    if (c === '(' || c === '<' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === '>' || c === ']' || c === '}') {
      if (depth === 0 && chars.includes(c)) return i;
      depth--;
    } else if (depth === 0 && chars.includes(c)) return i;
  }
  return -1;
}

/** Does the class declare an `@Inject constructor(...)`? (Hilt/Dagger injection point.) */
export function hasInjectConstructor(code: string): boolean {
  return /@Inject\s+(?:internal\s+|private\s+|public\s+)?constructor\s*\(/.test(sanitizeKotlin(code));
}

/** A function/method declaration split into its parameter types and return type. */
export interface FunctionParts {
  paramTypes: string[];
  returnType: string | null;
}

/**
 * Parse the FIRST `fun name(params): ReturnType` in a source span. Param types
 * are the bare base names (generics/nullability stripped); the return type is
 * the base name between the closing `)` and the `=`/`{`/end. Used by the DI pass
 * to read what a provider produces and what a constructor injects.
 */
export function functionParts(code: string): FunctionParts {
  const sanitized = sanitizeKotlin(code);
  const funIdx = /\bfun\b/.exec(sanitized)?.index ?? -1;
  if (funIdx === -1) return { paramTypes: [], returnType: null };
  let i = funIdx + 3;
  const n = sanitized.length;
  while (i < n && sanitized[i] !== '(') {
    if (sanitized[i] === '{' || sanitized[i] === '=') return { paramTypes: [], returnType: null };
    i++;
  }
  if (sanitized[i] !== '(') return { paramTypes: [], returnType: null };
  const close = matchBracket(sanitized, i);
  if (close === -1) return { paramTypes: [], returnType: null };

  const paramTypes: string[] = [];
  for (const { start, end } of splitTopLevel(sanitized.slice(i + 1, close), i + 1)) {
    const colon = indexOfTopLevel(sanitized, ':', start, end);
    if (colon === -1) continue;
    const eq = indexOfTopLevel(sanitized, '=', colon + 1, end);
    const t = code.slice(colon + 1, eq === -1 ? end : eq).trim();
    if (t) paramTypes.push(baseName(t.replace(/\?$/, '')));
  }

  // Return type: after `)`, an optional `: Type`, ending at `=` / `{` / newline-end.
  let r = close + 1;
  while (r < n && /\s/.test(sanitized[r]!)) r++;
  let returnType: string | null = null;
  if (sanitized[r] === ':') {
    const stop = indexOfTopLevelAny(sanitized, ['=', '{'], r + 1, n);
    const raw = code.slice(r + 1, stop === -1 ? n : stop).trim();
    if (raw) returnType = baseName(raw.replace(/\?$/, ''));
  }
  return { paramTypes, returnType };
}

/** The supertype list after `:` in a class/object header (interfaces + base class). */
export function superTypes(code: string): string[] {
  const sanitized = sanitizeKotlin(code);
  const kw = declarationKeywordIndex(sanitized);
  if (kw === -1) return [];
  // Skip the primary constructor parens so a `:` inside it isn't mistaken for the supertype colon.
  let i = kw;
  const n = sanitized.length;
  while (i < n && sanitized[i] !== '{' && sanitized[i] !== '(' && sanitized[i] !== ':') i++;
  if (sanitized[i] === '(') {
    const close = matchBracket(sanitized, i);
    i = close === -1 ? n : close + 1;
  }
  while (i < n && /\s/.test(sanitized[i]!)) i++;
  if (sanitized[i] !== ':') return [];
  const bodyStart = i + 1;
  let bodyEnd = bodyStart;
  while (bodyEnd < n && sanitized[bodyEnd] !== '{') bodyEnd++;
  return splitTopLevel(sanitized.slice(bodyStart, bodyEnd), bodyStart)
    .map((s) => baseName(code.slice(s.start, s.end).trim()))
    .filter((s) => s.length > 0);
}

/** `Foo<Bar>(...)` / `com.x.Foo` → `Foo`. */
function baseName(typeExpr: string): string {
  let t = typeExpr.trim();
  const lt = t.indexOf('<');
  if (lt !== -1) t = t.slice(0, lt);
  const paren = t.indexOf('(');
  if (paren !== -1) t = t.slice(0, paren);
  t = t.trim();
  const dot = t.lastIndexOf('.');
  return (dot !== -1 ? t.slice(dot + 1) : t).trim();
}

// ---------------------------------------------------------------------------
// U7 · semantic-constant primitives (L3 migration-invariant literals).
//
// `sanitizeKotlin` BLANKS literal CONTENTS, so every value below is recovered by
// slicing the ORIGINAL `code` at offsets computed on the sanitized text — the
// same offset-mapping trick `annotationArg` already relies on.
// ---------------------------------------------------------------------------

/** A compile-time constant recovered from a `const val` declaration. */
export interface KotlinConstant {
  name: string;
  /** The literal's VALUE (string content without quotes, or the numeric text). */
  value: string;
  valueKind: 'string' | 'number';
}

/**
 * Every `const val NAME = <literal>` in a source span (top-level, `object` body,
 * or `companion object` body). Only SINGLE string/number literals are returned —
 * a value that is an expression, concatenation, or reference is skipped. Values
 * are sliced from the original `code`, so string contents survive sanitization.
 */
export function topLevelConstants(code: string): KotlinConstant[] {
  const sanitized = sanitizeKotlin(code);
  const out: KotlinConstant[] = [];
  const re = /\bconst\s+val\s+([A-Za-z_]\w*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sanitized)) !== null) {
    const name = m[1]!;
    const eq = indexOfTopLevel(sanitized, '=', m.index + m[0].length, sanitized.length);
    if (eq === -1) continue;
    const valEnd = statementEnd(sanitized, eq + 1);
    const raw = code.slice(eq + 1, valEnd).trim();
    const str = parseKotlinStringLiteral(raw);
    if (str !== null) {
      out.push({ name, value: str, valueKind: 'string' });
      continue;
    }
    const num = parseKotlinNumberLiteral(raw);
    if (num !== null) out.push({ name, value: num, valueKind: 'number' });
  }
  return out;
}

/** The entry names of an `enum class` body (identifiers before the first `;`). */
export function enumEntries(code: string): string[] {
  const sanitized = sanitizeKotlin(code);
  const header = /\benum\s+class\s+[A-Za-z_]\w*/.exec(sanitized);
  if (!header) return [];
  let i = header.index + header[0].length;
  const n = sanitized.length;
  while (i < n && sanitized[i] !== '{') i++;
  if (sanitized[i] !== '{') return [];
  const close = matchBracket(sanitized, i);
  if (close === -1) return [];
  const bodyStart = i + 1;
  const semi = indexOfTopLevel(sanitized, ';', bodyStart, close);
  const entryEnd = semi === -1 ? close : semi;
  const names: string[] = [];
  for (const { start, end } of splitTopLevel(sanitized.slice(bodyStart, entryEnd), bodyStart)) {
    const em = /^[A-Za-z_]\w*/.exec(sanitized.slice(start, end).trim());
    if (em) names.push(em[0]);
  }
  return names;
}

/**
 * The FIRST positional string argument of `@<annotation>(...)`, e.g.
 * `@GET("/topics")` → `/topics`, `@Query("SELECT …")` → `SELECT …`. A leading
 * `name =` (the `@GET(value = "…")` form) is tolerated. Null when the annotation
 * is absent or its first argument is not a string literal.
 */
export function annotationPositionalArg(code: string, annotation: string): string | null {
  const sanitized = sanitizeKotlin(code);
  const re = new RegExp(`@${annotation}\\s*\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(sanitized)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(sanitized, open);
    if (close === -1) continue;
    const comma = indexOfTopLevel(sanitized, ',', open + 1, close);
    const argEnd = comma === -1 ? close : comma;
    const raw = code.slice(open + 1, argEnd).trim().replace(/^[A-Za-z_]\w*\s*=\s*/, '');
    const str = parseKotlinStringLiteral(raw);
    if (str !== null) return str;
  }
  return null;
}

/** Offset of the end of a statement starting at `from`: a top-level newline or `;`. */
function statementEnd(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    if (c === '(' || c === '[' || c === '{' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '}' || c === '>') depth--;
    else if ((c === '\n' || c === ';') && depth <= 0) return i;
  }
  return text.length;
}

/** `"abc"` / `"""abc"""` → `abc`, iff the whole `raw` IS one string literal. */
function parseKotlinStringLiteral(raw: string): string | null {
  if (raw.startsWith('"""')) {
    const end = raw.indexOf('"""', 3);
    if (end === -1) return null;
    if (raw.slice(end + 3).trim() !== '') return null;
    return raw.slice(3, end);
  }
  if (raw.startsWith('"')) {
    let i = 1;
    for (; i < raw.length; i++) {
      if (raw[i] === '\\') i++;
      else if (raw[i] === '"') break;
    }
    if (i >= raw.length || raw[i] !== '"') return null;
    if (raw.slice(i + 1).trim() !== '') return null;
    return raw.slice(1, i);
  }
  return null;
}

/** `42` / `-3.5f` / `0xFF` / `1_000L` → the trimmed text, iff `raw` IS one number. */
function parseKotlinNumberLiteral(raw: string): string | null {
  if (/^-?0[xX][0-9a-fA-F_]+[uUlL]*$/.test(raw)) return raw;
  if (/^-?0[bB][01_]+[uUlL]*$/.test(raw)) return raw;
  if (/^-?\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?[fFdDuUlL]*$/.test(raw)) return raw;
  return null;
}
