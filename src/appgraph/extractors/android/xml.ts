/**
 * Minimal, dependency-free XML reader scoped to AndroidManifest.xml.
 *
 * CodeGraph parses XML with hand-written string matching too (see
 * `MyBatisExtractor`) — there is no XML tree-sitter grammar bundled. Manifests
 * are a small, well-structured subset (elements + attributes, comments, self-
 * closing tags, no CDATA/DTD), so a focused parser is deterministic and enough.
 */

export interface XmlElement {
  tag: string;
  attrs: Record<string, string>;
  children: XmlElement[];
}

/** Parse an XML document into its root element, or null if none found. */
export function parseXml(source: string): XmlElement | null {
  const text = stripNonElements(source);
  const roots: XmlElement[] = [];
  const stack: XmlElement[] = [];
  const tagRe = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^<>]*?)?)(\/?)>/g;

  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(text)) !== null) {
    const closing = match[1];
    const tag = match[2];
    const rawAttrs = match[3] ?? '';
    const selfClose = match[4];
    if (!tag) continue;

    if (closing) {
      // Closing tag: pop up to the matching open element.
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]?.tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }

    const el: XmlElement = { tag, attrs: parseAttrs(rawAttrs), children: [] };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(el);
    else roots.push(el);

    if (!selfClose) stack.push(el);
  }

  return roots[0] ?? null;
}

/** Remove comments, processing instructions, and DOCTYPE so the tag scanner stays simple. */
function stripNonElements(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '');
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /([\w.:-]+)\s*=\s*"([^"]*)"|([\w.:-]+)\s*=\s*'([^']*)'/g;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(raw)) !== null) {
    const key = match[1] ?? match[3];
    const value = match[2] ?? match[4] ?? '';
    if (key) attrs[key] = value;
  }
  return attrs;
}

/** Depth-first walk yielding every element (root included). */
export function walk(root: XmlElement, visit: (el: XmlElement) => void): void {
  visit(root);
  for (const child of root.children) walk(child, visit);
}

/** Direct children matching a tag name. */
export function childrenNamed(el: XmlElement, tag: string): XmlElement[] {
  return el.children.filter((c) => c.tag === tag);
}
