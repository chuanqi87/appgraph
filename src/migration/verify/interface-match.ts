/**
 * Public-interface acceptance matching — the pure decision behind an L1
 * `interface` check, split out of `unit.ts` so it is directly testable without
 * standing up a target surface.
 *
 * The invariant it protects: a source public type is "migrated" iff a
 * correspondingly-named export exists on the target. The subtlety is SAME-NAMED
 * nested types. Java freely declares an `Action`/`State`/`Type`/`Builder`
 * nested inside several outer classes; ArkTS forbids nested type declarations,
 * so each is hoisted to a DISTINCT top-level export. Matching by the bare simple
 * name (`Action`) then can't tell them apart, and a single bare-name ledger
 * rename would spuriously satisfy all of them — masking a type that was never
 * translated. So a bare rename is trusted only when the simple name is unique in
 * the unit; colliding names must be disambiguated by their type-path
 * (`FeedEvent.Action`).
 */

import { ContractCheck } from '../plan/contract';
import { isNestedType, typePathKey } from '../qualified-name';

/** Ledger renames split by key shape (bare simple name vs. dotted type-path). */
export interface RenameMaps {
  /** lowercased bare name → target export. */
  bySimple: Map<string, string>;
  /** lowercased dotted type-path (`feedevent.action`) → target export. */
  byQualified: Map<string, string>;
}

export interface InterfaceMatchContext {
  /** Lowercased target export names. */
  exportNames: Set<string>;
  renames: RenameMaps;
  /** lowercased simple name → # of interface checks sharing it (collision guard). */
  interfaceNameCounts: Map<string, number>;
}

export interface InterfaceMatch {
  pass: boolean;
  /** The absent type named as precisely as the subject allows (for the report). */
  evidence: string[];
}

/**
 * Resolve one interface check against the target. Order:
 *   1. a qualified rename keyed by the type-path — always trusted,
 *   2. a bare-name rename — trusted ONLY when the simple name is unique here,
 *   3. a direct same-named target export.
 */
export function matchInterface(check: ContractCheck, ctx: InterfaceMatchContext): InterfaceMatch {
  const simple = String(check.params?.name ?? '');
  const qkey = typePathKey(check.subject); // "FeedEvent.Action" | "Action"
  const ambiguous = (ctx.interfaceNameCounts.get(simple.toLowerCase()) ?? 0) > 1;
  // Name the type by its type-path when that carries more than the bare name
  // (nested or colliding), so a miss says exactly which one is absent.
  const evidence = [isNestedType(check.subject) || ambiguous ? qkey : simple];

  const qualified = ctx.renames.byQualified.get(qkey.toLowerCase());
  if (qualified !== undefined) {
    return { pass: ctx.exportNames.has(qualified.toLowerCase()), evidence };
  }
  if (!ambiguous) {
    const bare = ctx.renames.bySimple.get(simple.toLowerCase());
    if (bare !== undefined) {
      return { pass: ctx.exportNames.has(bare.toLowerCase()), evidence };
    }
  }
  return { pass: ctx.exportNames.has(simple.toLowerCase()), evidence };
}

/**
 * Split a ledger `exportMap` into bare-name vs. type-path renames. A key that
 * carries structure (`FeedEvent.Action` or the full `pkg::FeedEvent::Action`
 * subject) becomes a qualified rename normalized to a lowercase dotted
 * type-path; a plain `Action` becomes a bare rename.
 */
export function splitRenameMaps(exportMap: Record<string, string>): RenameMaps {
  const bySimple = new Map<string, string>();
  const byQualified = new Map<string, string>();
  for (const [key, target] of Object.entries(exportMap)) {
    if (key.includes('::') || key.includes('.')) {
      byQualified.set((key.includes('::') ? typePathKey(key) : key).toLowerCase(), target);
    } else {
      bySimple.set(key.toLowerCase(), target);
    }
  }
  return { bySimple, byQualified };
}

/** Count interface-check simple names to spot bare-name collisions in a unit. */
export function countInterfaceNames(checks: ContractCheck[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of checks) {
    if (c.kind !== 'interface') continue;
    const simple = String(c.params?.name ?? '').toLowerCase();
    if (!simple) continue;
    counts.set(simple, (counts.get(simple) ?? 0) + 1);
  }
  return counts;
}
