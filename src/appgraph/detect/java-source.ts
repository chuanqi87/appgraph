/**
 * Shared, dependency-free JAVA source parsing for the U-track detect passes.
 *
 * codegraph does NOT fill `Node.decorators` for Java either (verified on
 * AntennaPod: 0 of 793 `java`/`class` nodes carry a non-empty `decorators`
 * column), and Java uses `extends`/`implements` + `static final` where Kotlin
 * uses `: Base` + `const val` — so the Kotlin primitives in `kotlin-source`
 * (`superTypes`, `topLevelConstants`) do not recognize the Java forms. This file
 * recovers the Java-shaped facts from the symbol's source span, reusing the
 * language-agnostic scanners (`sanitizeKotlin` / `splitTopLevel`) from
 * `kotlin-source` — those only blank string/char/comment contents and split on
 * balanced brackets, which is identical for Java.
 *
 * Everything here is PURE and DETERMINISTIC: same source in → same facts out.
 * Values are recovered by slicing the ORIGINAL `code` at offsets computed on the
 * sanitized text (sanitization blanks literal contents), the same trick the
 * Kotlin primitives rely on.
 */

import { sanitizeKotlin, splitTopLevel, KotlinConstant, KotlinField, matchBracket } from './kotlin-source';

/**
 * The supertype base names of a Java `class`/`interface`/`enum` declaration:
 * the `extends` base class plus every `implements` interface, generics stripped.
 * The Kotlin `superTypes` parser reads `: Base` and cannot see Java's
 * `extends`/`implements` — this is the Java bypass (used for custom-View
 * detection, where the base name is matched against `isAndroidViewSuper`).
 *
 * A bounded type parameter (`<T extends View>`) is NOT a supertype and is
 * skipped: the scan tracks `<`/`(`/`[` depth and only reads the `extends`/
 * `implements` keywords that sit at top level, after the declaration name.
 */
export function javaSuperTypes(code: string): string[] {
  const s = sanitizeKotlin(code);
  const decl = /\b(?:class|interface|enum)\s+[A-Za-z_$][\w$]*/.exec(s);
  if (!decl) return [];
  const start = decl.index + decl[0].length;

  // Header = everything from just after the declaration name up to the top-level
  // `{` that opens the class body (bracket-depth 0, so a `{` inside `<…>` args
  // can't fool it — though a well-formed header has none).
  let end = s.length;
  let depth = 0;
  for (let k = start; k < s.length; k++) {
    const c = s[k]!;
    if (c === '<' || c === '(' || c === '[') depth++;
    else if (c === '>' || c === ')' || c === ']') depth--;
    else if (c === '{' && depth === 0) {
      end = k;
      break;
    }
  }
  const header = s.slice(start, end);

  const out: string[] = [];
  for (const kw of ['extends', 'implements'] as const) {
    const re = new RegExp(`\\b${kw}\\b`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(header)) !== null) {
      if (bracketDepthAt(header, m.index) !== 0) continue; // inside `<…>` bound
      // The type list runs to the next top-level extends/implements keyword or end.
      let listEnd = header.length;
      const nre = /\b(?:extends|implements)\b/g;
      nre.lastIndex = m.index + kw.length;
      let nm: RegExpExecArray | null;
      while ((nm = nre.exec(header)) !== null) {
        if (bracketDepthAt(header, nm.index) === 0) {
          listEnd = nm.index;
          break;
        }
      }
      const list = header.slice(m.index + kw.length, listEnd);
      for (const seg of splitTopLevel(list, 0)) {
        const name = baseName(list.slice(seg.start, seg.end).trim());
        if (name) out.push(name);
      }
    }
  }
  return out;
}

/** Bracket depth (`<`/`(`/`[`) at index `idx` in `text`. */
function bracketDepthAt(text: string, idx: number): number {
  let depth = 0;
  for (let k = 0; k < idx; k++) {
    const c = text[k]!;
    if (c === '<' || c === '(' || c === '[') depth++;
    else if (c === '>' || c === ')' || c === ']') depth--;
  }
  return depth;
}

/**
 * Every `static final <Type> NAME = <literal>` in a source span. Only SINGLE
 * string/number literals are returned (an expression, concatenation, method
 * call, or reference is skipped) — mirroring `topLevelConstants` for Kotlin, so
 * the results drop straight into the same `literals` structure. Values are
 * sliced from the ORIGINAL `code` (sanitization blanks string contents).
 */
export function javaStaticFinalConstants(code: string): KotlinConstant[] {
  const sanitized = sanitizeKotlin(code);
  const out: KotlinConstant[] = [];
  // `static final` (in either order after the visibility modifier), a type, a
  // NAME, then `=`. `[\w$.<>\[\] ]` in the type covers `String`, `int[]`,
  // `List<String>`, and fully-qualified `com.x.Type`.
  const re = /\bstatic\s+final\s+[\w$.]+(?:\s*<[^=;{}]*>)?(?:\s*\[\s*\])*\s+([A-Za-z_$][\w$]*)\s*=/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sanitized)) !== null) {
    const name = m[1]!;
    const eq = m.index + m[0].length - 1; // index of the `=`
    const valEnd = statementEnd(sanitized, eq + 1);
    const raw = code.slice(eq + 1, valEnd).trim();
    const str = parseJavaStringLiteral(raw);
    if (str !== null) {
      out.push({ name, value: str, valueKind: 'string' });
      continue;
    }
    const num = parseJavaNumberLiteral(raw);
    if (num !== null) out.push({ name, value: num, valueKind: 'number' });
  }
  return out;
}

/** `Foo<Bar>` / `com.x.Foo` / `int[]` → `Foo` / `Foo` / `int`. */
function baseName(typeExpr: string): string {
  let t = typeExpr.trim();
  const lt = t.indexOf('<');
  if (lt !== -1) t = t.slice(0, lt);
  const bracket = t.indexOf('[');
  if (bracket !== -1) t = t.slice(0, bracket);
  t = t.trim();
  const dot = t.lastIndexOf('.');
  return (dot !== -1 ? t.slice(dot + 1) : t).trim();
}

/** End of a field-initializer statement: the next top-level `;` or `,`, else end. */
function statementEnd(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    if (c === '(' || c === '[' || c === '{' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '}' || c === '>') depth--;
    else if ((c === ';' || c === ',') && depth <= 0) return i;
  }
  return text.length;
}

/** `"abc"` / `"""abc"""` → `abc`, iff the whole `raw` IS one string literal. */
function parseJavaStringLiteral(raw: string): string | null {
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
function parseJavaNumberLiteral(raw: string): string | null {
  if (/^-?0[xX][0-9a-fA-F_]+[lL]?$/.test(raw)) return raw;
  if (/^-?0[bB][01_]+[lL]?$/.test(raw)) return raw;
  if (/^-?\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?[fFdDlL]?$/.test(raw)) return raw;
  return null;
}

// ---------------------------------------------------------------------------
// Java POJO field schema (U3 · data-model extraction for the Java old-style stack).
//
// Kotlin data models declare their fields in the primary constructor
// (`parsePrimaryConstructor`); Java models declare them as class-body fields with
// getters/setters. This recovers those instance fields as `KotlinField`s so they
// flow through the SAME `entities.toFieldSchema` normalization.
// ---------------------------------------------------------------------------

/** Java modifier keywords that can precede a field type. */
const JAVA_MODIFIERS = new Set([
  'public',
  'private',
  'protected',
  'static',
  'final',
  'volatile',
  'transient',
  'synchronized',
  'native',
  'abstract',
  'default',
  'strictfp',
]);

/** Java primitive types — non-nullable value types. */
const JAVA_PRIMITIVES = new Set(['int', 'long', 'short', 'byte', 'char', 'boolean', 'float', 'double']);

/** Max instance fields recovered from one class body (bounded output). */
const MAX_JAVA_FIELDS = 300;

/**
 * The INSTANCE fields of a Java class/record body, as `KotlinField`s so they drop
 * straight into `entities.toFieldSchema` (which reads `annotations` for
 * `@PrimaryKey`/`@ColumnInfo`). `static` fields (constants) are excluded — they
 * are not persistent state. Methods, constructors, initializer blocks and nested
 * types are skipped. Operates on the sanitized span (string/comment contents
 * blanked) so a `;`/`{` inside a literal can't split a member wrongly.
 */
export function javaFields(code: string): KotlinField[] {
  const s = sanitizeKotlin(code);
  const decl = /\b(?:class|record|enum)\s+[A-Za-z_$][\w$]*/.exec(s);
  if (!decl) return [];
  // Only a class/record body holds data fields; an enum body starts with constants.
  if (!/\b(?:class|record)\b/.test(decl[0])) return [];

  // The `{` that opens the class body (bracket-depth 0 after the declaration name).
  let bodyOpen = -1;
  let headerDepth = 0;
  for (let k = decl.index + decl[0].length; k < s.length; k++) {
    const c = s[k]!;
    if (c === '<' || c === '(' || c === '[') headerDepth++;
    else if (c === '>' || c === ')' || c === ']') headerDepth--;
    else if (c === '{' && headerDepth === 0) {
      bodyOpen = k;
      break;
    }
  }
  if (bodyOpen === -1) return [];
  const bodyClose = matchBracket(s, bodyOpen);
  if (bodyClose === -1) return [];

  const fields: KotlinField[] = [];
  let i = bodyOpen + 1;
  let memberStart = i;
  let pdepth = 0;
  while (i < bodyClose && fields.length < MAX_JAVA_FIELDS) {
    const c = s[i]!;
    if (c === '(' || c === '[' || c === '<') {
      pdepth++;
    } else if (c === ')' || c === ']' || c === '>') {
      if (pdepth > 0) pdepth--;
    } else if (pdepth === 0 && c === '{') {
      // A member WITH a body (method / constructor / static block / nested type) —
      // skip the whole braced block, then the optional trailing `;`.
      const close = matchBracket(s, i);
      if (close === -1) break;
      i = close + 1;
      while (i < bodyClose && /\s/.test(s[i]!)) i++;
      if (s[i] === ';') i++;
      memberStart = i;
      continue;
    } else if (pdepth === 0 && c === ';') {
      const field = parseJavaFieldHeader(s, memberStart, i);
      if (field) fields.push(field);
      i++;
      memberStart = i;
      continue;
    }
    i++;
  }
  return fields;
}

/** Parse a `;`-terminated member header into an instance field, or null. */
function parseJavaFieldHeader(s: string, start: number, end: number): KotlinField | null {
  const eq = firstTopLevel(s, '=', start, end);
  const declS = s.slice(start, eq === -1 ? end : eq);
  // An abstract/interface method decl reaches its trailing `;` too, but its
  // header carries `(` — never a field.
  if (declS.includes('(')) return null;

  // Per-field annotation simple-names (annotation args are blanked in `s`).
  const annotations: string[] = [];
  const annRe = /@([A-Za-z_][\w.]*)/g;
  let am: RegExpExecArray | null;
  while ((am = annRe.exec(declS)) !== null) {
    const raw = am[1]!;
    annotations.push(raw.includes('.') ? raw.slice(raw.lastIndexOf('.') + 1) : raw);
  }
  // Strip the annotations (name + optional `(...)`) from the declaration text.
  const declText = declS.replace(/@[A-Za-z_][\w.]*\s*(?:\([^)]*\))?/g, ' ').trim();

  // Trailing field name (+ optional C-style array brackets `name[]`).
  const nm = /([A-Za-z_$][\w$]*)\s*(?:\[\s*\])*\s*$/.exec(declText);
  if (!nm) return null;
  const name = nm[1]!;
  let typePart = declText.slice(0, nm.index).trim();

  // Peel leading Java modifiers; a `static` member is not instance data.
  let isStatic = false;
  const modRe = /^([A-Za-z_]\w*)\b\s*/;
  let mm: RegExpExecArray | null;
  while ((mm = modRe.exec(typePart)) && JAVA_MODIFIERS.has(mm[1]!)) {
    if (mm[1] === 'static') isStatic = true;
    typePart = typePart.slice(mm[0].length);
  }
  if (isStatic) return null;
  const type = typePart.trim();
  if (!type || !/^[A-Za-z_$]/.test(type)) return null;

  const nullable = !JAVA_PRIMITIVES.has(baseName(type).toLowerCase());
  return { name, type, nullable, annotations, hasDefault: eq !== -1 };
}

/** First index of `ch` at bracket-depth 0 within `[from,to)`, or -1. */
function firstTopLevel(text: string, ch: string, from: number, to: number): number {
  let depth = 0;
  for (let i = from; i < to; i++) {
    const c = text[i]!;
    if (c === '(' || c === '<' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === '>' || c === ']' || c === '}') depth--;
    else if (c === ch && depth === 0) return i;
  }
  return -1;
}
