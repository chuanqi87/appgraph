/**
 * L1 interface-acceptance matching — the fix for same-named nested types.
 *
 * The bug this locks down: three different outer classes each declaring a nested
 * `Action` collapse to one bare match key, so a single bare-name ledger rename
 * used to "pass" all three interface checks — masking a type that was never
 * translated. Matching now disambiguates by type-path and only trusts a bare
 * rename when the simple name is unique in the unit.
 */

import { describe, it, expect } from 'vitest';
import { ContractCheck } from '../../src/migration/plan/contract';
import { typePath, typePathKey, isNestedType } from '../../src/migration/qualified-name';
import {
  matchInterface,
  splitRenameMaps,
  countInterfaceNames,
  InterfaceMatchContext,
} from '../../src/migration/verify/interface-match';

function mkInterfaceCheck(subject: string, name: string): ContractCheck {
  return {
    id: subject,
    tier: 'L1',
    kind: 'interface',
    moduleId: 'm',
    moduleName: 'event',
    subject,
    expect: '',
    verify: 'auto',
    params: { name },
    depth: 'name-only',
  };
}

/** Build a match context from target export names + a raw ledger exportMap. */
function ctxFor(exports: string[], exportMap: Record<string, string>, checks: ContractCheck[]): InterfaceMatchContext {
  return {
    exportNames: new Set(exports.map((e) => e.toLowerCase())),
    renames: splitRenameMaps(exportMap),
    interfaceNameCounts: countInterfaceNames(checks),
  };
}

const FEED = 'de.danoeh.antennapod.event::FeedEvent::Action';
const QUEUE = 'de.danoeh.antennapod.event::QueueEvent::Action';
const PLAYBACK = 'de.danoeh.antennapod.event::PlaybackServiceEvent::Action';

describe('qualified-name parsing', () => {
  it('splits the package off the type-nesting chain', () => {
    expect(typePath(FEED)).toEqual(['FeedEvent', 'Action']);
    expect(typePathKey(FEED)).toBe('FeedEvent.Action');
    expect(isNestedType(FEED)).toBe(true);
  });

  it('treats a top-level type as its own bare key', () => {
    expect(typePath('pkg.sub::Feed')).toEqual(['Feed']);
    expect(typePathKey('pkg.sub::Feed')).toBe('Feed');
    expect(isNestedType('pkg.sub::Feed')).toBe(false);
  });

  it('tolerates a bare name with no package separator', () => {
    expect(typePathKey('Bare')).toBe('Bare');
    expect(isNestedType('Bare')).toBe(false);
  });
});

describe('same-named nested types (the Action collision)', () => {
  const checks = [FEED, QUEUE, PLAYBACK].map((s) => mkInterfaceCheck(s, 'Action'));
  const targets = ['FeedEventAction', 'QueueAction', 'PlaybackServiceAction'];

  it('counts the collision', () => {
    expect(countInterfaceNames(checks).get('action')).toBe(3);
  });

  it('does NOT let one bare rename satisfy all three (the bug)', () => {
    // The ledger only carries a single bare `Action=PlaybackServiceAction`.
    const ctx = ctxFor(targets, { Action: 'PlaybackServiceAction' }, checks);
    // All three are ambiguous → the bare rename is ignored → none of them is a
    // literal `Action` export → every check fails, demanding qualified renames.
    for (const c of checks) expect(matchInterface(c, ctx).pass).toBe(false);
  });

  it('passes when each is registered by its type-path', () => {
    const ctx = ctxFor(
      targets,
      {
        'FeedEvent.Action': 'FeedEventAction',
        'QueueEvent.Action': 'QueueAction',
        'PlaybackServiceEvent.Action': 'PlaybackServiceAction',
      },
      checks
    );
    for (const c of checks) expect(matchInterface(c, ctx).pass).toBe(true);
  });

  it('catches the ONE missing translation, passes the others', () => {
    // QueueAction was never translated; the qualified renames are all present.
    const ctx = ctxFor(
      ['FeedEventAction', 'PlaybackServiceAction'],
      {
        'FeedEvent.Action': 'FeedEventAction',
        'QueueEvent.Action': 'QueueAction',
        'PlaybackServiceEvent.Action': 'PlaybackServiceAction',
      },
      checks
    );
    const bySubject = new Map(checks.map((c) => [c.subject, matchInterface(c, ctx)]));
    expect(bySubject.get(FEED)!.pass).toBe(true);
    expect(bySubject.get(PLAYBACK)!.pass).toBe(true);
    const queue = bySubject.get(QUEUE)!;
    expect(queue.pass).toBe(false);
    // The miss is named by its type-path, not the ambiguous bare `Action`.
    expect(queue.evidence).toEqual(['QueueEvent.Action']);
  });

  it('accepts a rename keyed by the full subject too', () => {
    const ctx = ctxFor(targets, { [FEED]: 'FeedEventAction' }, checks);
    expect(matchInterface(mkInterfaceCheck(FEED, 'Action'), ctx).pass).toBe(true);
  });
});

describe('unique names — backward compatibility', () => {
  it('honors a bare rename when the simple name is unique', () => {
    const check = mkInterfaceCheck('pkg::SortOrder::Scope', 'Scope');
    const ctx = ctxFor(['SortOrderScope'], { Scope: 'SortOrderScope' }, [check]);
    expect(matchInterface(check, ctx).pass).toBe(true);
  });

  it('passes a direct same-named export with no rename', () => {
    const check = mkInterfaceCheck('pkg::Feed', 'Feed');
    const ctx = ctxFor(['Feed', 'FeedItem'], {}, [check]);
    expect(matchInterface(check, ctx).pass).toBe(true);
  });

  it('fails a missing top-level type, named by its bare name', () => {
    const check = mkInterfaceCheck('pkg::Feed', 'Feed');
    const ctx = ctxFor(['FeedItem'], {}, [check]);
    const m = matchInterface(check, ctx);
    expect(m.pass).toBe(false);
    expect(m.evidence).toEqual(['Feed']);
  });

  it('names a missing unique nested type by its type-path', () => {
    const check = mkInterfaceCheck('pkg::Outer::Inner', 'Inner');
    const ctx = ctxFor(['Something'], {}, [check]);
    const m = matchInterface(check, ctx);
    expect(m.pass).toBe(false);
    expect(m.evidence).toEqual(['Outer.Inner']);
  });
});

describe('splitRenameMaps key-shape routing', () => {
  it('routes dotted / subject keys to qualified and bare keys to simple', () => {
    const { bySimple, byQualified } = splitRenameMaps({
      Action: 'PlaybackServiceAction',
      'FeedEvent.Action': 'FeedEventAction',
      'pkg::QueueEvent::Action': 'QueueAction',
    });
    expect(bySimple.get('action')).toBe('PlaybackServiceAction');
    expect(byQualified.get('feedevent.action')).toBe('FeedEventAction');
    expect(byQualified.get('queueevent.action')).toBe('QueueAction');
  });
});
