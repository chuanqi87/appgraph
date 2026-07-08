/**
 * Qualified-name parsing shared by the plan (work-order rendering) and the
 * verify layer (interface-check disambiguation).
 *
 * A codegraph `qualifiedName` (identical to a contract check's `subject`) is
 * shaped `pkg.sub.pkg::Outer::Inner`: the FIRST `::`-segment is the dotted
 * package, and every segment AFTER it is the type-nesting chain. Java/Kotlin
 * nested types therefore show up as extra `::` segments — e.g.
 * `de.danoeh.antennapod.event::FeedEvent::Action`.
 *
 * These helpers exist because a bare simple name (`Action`) is NOT a safe match
 * key: three different outer classes can each declare a nested `Action`, and
 * ArkTS forces all three to be hoisted+renamed to distinct top-level exports.
 * The type-path key (`FeedEvent.Action`) is what disambiguates them.
 */

/**
 * The type-nesting chain (package stripped). `pkg::Outer::Inner` → `["Outer",
 * "Inner"]`; a bare `Name` with no `::` → `["Name"]`.
 */
export function typePath(qualifiedName: string): string[] {
  const segs = qualifiedName.split('::');
  return segs.length <= 1 ? segs : segs.slice(1);
}

/** Dotted type-path key, e.g. `FeedEvent.Action`; the bare name when top-level. */
export function typePathKey(qualifiedName: string): string {
  return typePath(qualifiedName).join('.');
}

/** A nested type (≥1 enclosing type) — the shape ArkTS cannot express directly. */
export function isNestedType(qualifiedName: string): boolean {
  return typePath(qualifiedName).length >= 2;
}
