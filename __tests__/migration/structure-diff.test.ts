/**
 * V1 + V2 · source ↔ target structural fidelity.
 *
 * Locks the acceptance criteria: a source screen with no target page is a
 * `missingInTarget` gap (delete a target screen → V1 catches it), and a source
 * entity field with no target field is a `missingFields` gap (delete a target
 * field → V2 catches it), with honest `fieldCheck` degradation when the target
 * parse can't recover fields.
 */

import { describe, it, expect } from 'vitest';
import { AppNode } from '../../src/appgraph/schema';
import { ArkExport } from '../../src/migration/verify/target-graph';
import { diffScreens, diffEntitySchemas } from '../../src/migration/verify/structure-diff';

function screen(name: string, platform: 'android' | 'harmony'): AppNode {
  return {
    id: `${platform}:${name}`,
    kind: 'Screen',
    matchKey: `screen:${name.toLowerCase()}`,
    name,
    platform,
    provenance: 'source-static',
    fidelity: 'source-project',
    confidence: 0.9,
  };
}

function dataModel(name: string, fields: Array<{ name: string; type: string }>): AppNode {
  return {
    id: `android:${name}`,
    kind: 'DataModel',
    matchKey: `datamodel:${name.toLowerCase()}`,
    name,
    platform: 'android',
    subtype: 'entity',
    provenance: 'source-static',
    fidelity: 'source-project',
    confidence: 0.9,
    attrs: { fields: fields.map((f) => ({ ...f, nullable: false, primaryKey: false, hasDefault: false })) },
  };
}

function arkExport(name: string, fields: string[]): ArkExport {
  return { name, kind: 'class', signature: name, file: `${name}.ets`, isComponent: false, fields };
}

describe('V1 · screen diff', () => {
  it('aligns by base name and catches a dropped target screen', () => {
    const source = [screen('ForYouScreen', 'android'), screen('TopicScreen', 'android')];
    // Target renamed to Page and dropped Topic.
    const target = [screen('ForYouPage', 'harmony')];
    const diff = diffScreens(source, target);
    expect(diff.matched).toEqual([{ source: 'ForYouScreen', target: 'ForYouPage' }]);
    expect(diff.missingInTarget).toEqual(['TopicScreen']);
  });

  it('reports all source screens missing when the target has none', () => {
    const diff = diffScreens([screen('A', 'android'), screen('B', 'android')], []);
    expect(diff.missingInTarget.sort()).toEqual(['A', 'B']);
    expect(diff.matched).toHaveLength(0);
  });
});

describe('V2 · entity schema diff', () => {
  const source = [dataModel('TopicEntity', [
    { name: 'id', type: 'String' },
    { name: 'name', type: 'String' },
    { name: 'url', type: 'String' },
  ])];

  it('full field check: catches a field dropped on the target', () => {
    const target = [arkExport('TopicEntity', ['id', 'name'])]; // url dropped
    const diff = diffEntitySchemas(source, target);
    expect(diff.models[0].fieldCheck).toBe('full');
    expect(diff.models[0].missingFields).toEqual(['url']);
    expect(diff.fieldsMissing).toBe(1);
  });

  it('full field check: passes when all fields survive (case-insensitive)', () => {
    const target = [arkExport('Topic', ['id', 'Name', 'url'])]; // base-name aligned, re-cased
    const diff = diffEntitySchemas(source, target);
    expect(diff.models[0].present).toBe(true);
    expect(diff.models[0].missingFields).toEqual([]);
    expect(diff.fieldsMissing).toBe(0);
  });

  it('name-only when the target class exists but fields could not be recovered', () => {
    const diff = diffEntitySchemas(source, [arkExport('TopicEntity', [])]);
    expect(diff.models[0].fieldCheck).toBe('name-only');
    expect(diff.models[0].present).toBe(true);
    expect(diff.fieldsMissing).toBe(0);
  });

  it('absent when there is no target class at all', () => {
    const diff = diffEntitySchemas(source, []);
    expect(diff.models[0].fieldCheck).toBe('absent');
    expect(diff.modelsMissing).toBe(1);
  });
});
