/**
 * L3 · target-side semantic scan.
 *
 * Writes a real temp HarmonyOS-shaped output tree and exercises the honest
 * contains-scan: literal hit/miss, per-unit path scoping, SQL whitespace
 * normalization, and enum word-boundary set-compare.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadTargetSources,
  scanLiteral,
  scanSql,
  scanEnumValues,
} from '../../src/migration/verify/semantic-scan';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'semscan-'));
  mkdirSync(join(root, 'entry/src/main/ets/net'), { recursive: true });
  mkdirSync(join(root, 'feature/src/main/ets'), { recursive: true });
  writeFileSync(
    join(root, 'entry/src/main/ets/net/api.ts'),
    "const BASE_URL = 'https://api.example.com/v1';\nfunction q() {\n  return db.querySql('SELECT  *  FROM  news');\n}\n"
  );
  writeFileSync(
    join(root, 'feature/src/main/ets/State.ets'),
    'enum SyncState { IDLE, RUNNING }\n// the third value was not ported\n'
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('loadTargetSources', () => {
  it('indexes .ets/.ts files with POSIX root-relative paths', () => {
    const index = loadTargetSources(root);
    expect(index.files.map((f) => f.path)).toEqual([
      'entry/src/main/ets/net/api.ts',
      'feature/src/main/ets/State.ets',
    ]);
  });

  it('honours a per-unit path-prefix scope', () => {
    const index = loadTargetSources(root, ['entry']);
    expect(index.files.map((f) => f.path)).toEqual(['entry/src/main/ets/net/api.ts']);
  });
});

describe('scanLiteral', () => {
  it('reports the file a literal appears in', () => {
    const index = loadTargetSources(root);
    expect(scanLiteral(index, 'https://api.example.com/v1')).toEqual({
      hit: true,
      files: ['entry/src/main/ets/net/api.ts'],
    });
    expect(scanLiteral(index, 'https://absent.example.com').hit).toBe(false);
  });
});

describe('scanSql', () => {
  it('matches across differing whitespace after folding both sides', () => {
    const index = loadTargetSources(root);
    expect(scanSql(index, 'SELECT * FROM news').hit).toBe(true);
    expect(scanSql(index, 'SELECT * FROM bookmarks').hit).toBe(false);
  });
});

describe('scanEnumValues', () => {
  it('splits present vs missing by word boundary', () => {
    const index = loadTargetSources(root);
    expect(scanEnumValues(index, ['IDLE', 'RUNNING', 'FAILED'])).toEqual({
      present: ['IDLE', 'RUNNING'],
      missing: ['FAILED'],
    });
  });
});
