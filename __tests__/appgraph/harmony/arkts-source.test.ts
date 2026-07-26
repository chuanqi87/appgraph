/**
 * ArkTS source micro-parsers.
 *
 * These are pure string functions, but they gate whether a struct counts as a
 * page and whether a route constant resolves — so their edge cases decide how
 * much of an app is visible at all. Every case below is a real corpus shape.
 */

import { describe, it, expect } from 'vitest';
import {
  buildBody,
  buildRootComponent,
  enumMemberStringValue,
  isNavDestinationPage,
  tracedFields,
} from '../../../src/appgraph/detect/arkts-source';

describe('enumMemberStringValue', () => {
  it('reads a single- or double-quoted member value', () => {
    expect(enumMemberStringValue("SAFE_PAGE = 'SafePage'")).toBe('SafePage');
    expect(enumMemberStringValue('ORDER = "OrderPage"')).toBe('OrderPage');
    expect(enumMemberStringValue("  SETTING   =   'SettingPage'  ")).toBe('SettingPage');
  });

  it('returns null for values that cannot be matched against a route table', () => {
    // A guessed route name is worse than an unresolved one.
    expect(enumMemberStringValue('COUNT = 3')).toBeNull();
    expect(enumMemberStringValue('COMPUTED = PREFIX + name')).toBeNull();
    expect(enumMemberStringValue('TPL = `page/${id}`')).toBeNull();
    expect(enumMemberStringValue('BARE_MEMBER')).toBeNull();
  });
});

describe('buildRootComponent / buildBody', () => {
  it('handles the plain form', () => {
    expect(buildRootComponent('build() {\n  NavDestination() {\n  }\n}')).toBe('NavDestination');
  });

  it('handles a declared return type — `build(): void {`', () => {
    // 195 corpus uses. Requiring `()` to touch `{` made all of them "not a page".
    expect(buildRootComponent('build(): void {\n  NavDestination() {\n  }\n}')).toBe(
      'NavDestination'
    );
    expect(buildRootComponent('public build(): void {\n  Column() {\n  }\n}')).toBe('Column');
  });

  it('skips leading comments inside the body', () => {
    expect(buildRootComponent('build() {\n  // 根容器\n  NavDestination() {}\n}')).toBe(
      'NavDestination'
    );
  });

  it('returns null when there is no build method', () => {
    expect(buildRootComponent('aboutToAppear() { doThing() }')).toBeNull();
  });

  it('extracts a brace-balanced body', () => {
    const body = buildBody('build() {\n  if (a) {\n    X()\n  }\n}\nother() { Y() }');
    expect(body).toContain('X()');
    expect(body).not.toContain('Y()');
  });
});

describe('isNavDestinationPage', () => {
  it('accepts a NavDestination root', () => {
    expect(isNavDestinationPage('build() {\n  NavDestination() {\n  }\n}')).toBe(true);
  });

  it('accepts a NavDestination wrapped in control flow', () => {
    // `build() { if (this.ready) { NavDestination() … } }` is still a page.
    expect(
      isNavDestinationPage('build() {\n  if (this.ready) {\n    NavDestination() {}\n  }\n}')
    ).toBe(true);
  });

  it('accepts it alongside a declared return type', () => {
    expect(isNavDestinationPage('build(): void {\n  NavDestination() {}\n}')).toBe(true);
  });

  it('rejects a plain reusable component', () => {
    expect(isNavDestinationPage('build() {\n  Column() {\n    Text("hi")\n  }\n}')).toBe(false);
  });

  it('does NOT count a NavDestination outside the struct build body', () => {
    // Searching the whole file (the old behaviour) let a component sitting next
    // to a page — or nesting one in a @Builder — pose as a page itself.
    const source = 'build() {\n  Column() {}\n}\n\n@Builder\nfn() {\n  NavDestination() {}\n}';
    expect(isNavDestinationPage(source)).toBe(false);
  });
});

describe('tracedFields', () => {
  it('collects @Trace properties and ignores untraced ones', () => {
    const source = `@ObservedV2
export class GlobalState {
  @Trace public activeTabId: string = '';
  @Trace isLoggedIn: boolean = false;
  private internalCounter: number = 0;
}`;
    expect(tracedFields(source)).toEqual(['activeTabId', 'isLoggedIn']);
  });

  it('returns an empty list when nothing is traced', () => {
    expect(tracedFields('export class Plain { a: string = ""; }')).toEqual([]);
  });
});
