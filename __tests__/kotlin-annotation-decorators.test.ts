/**
 * Kotlin annotation → node.decorators (AppGraph seam 1).
 *
 * The Compose/DI resolvers key off annotation simple names being queryable
 * facts. `extractModifiers` surfaces them on `node.decorators` alongside the
 * pre-existing Kotlin Multiplatform `expect`/`actual` markers — this pins that
 * both coexist and that a bare declaration stays undecorated.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { CodeSymbolGraph } from '../src/appgraph/graph-reader';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function index(root: string, rel: string, src: string): CodeSymbolGraph {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, src, 'utf8');
  const cg = CodeGraph.initSync(root);
  return cg;
}

describe('Kotlin annotation decorators', () => {
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it('surfaces @Composable / @HiltViewModel / @Binds simple names on decorators', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-anno-'));
    const cg = index(
      tmp,
      'app/src/main/java/com/x/F.kt',
      'package com.x\n' +
        'import androidx.compose.runtime.Composable\n' +
        '@HiltViewModel\n' +
        'class FooVM {\n' +
        '  @Composable fun Screen() {}\n' +
        '  @Binds fun bind(): R = RImpl()\n' +
        '}\n' +
        '@Composable fun TopBar() {}\n' +
        'fun plain() {}\n'
    );
    await cg.indexAll();
    cg.close();

    const reader = CodeSymbolGraph.open(tmp);
    try {
      const by = (name: string) => reader.getAllNodes().find((n) => n.name === name);
      expect(by('FooVM')?.decorators).toContain('HiltViewModel');
      expect(by('Screen')?.decorators).toContain('Composable');
      expect(by('bind')?.decorators).toContain('Binds');
      expect(by('TopBar')?.decorators).toContain('Composable');
      // A bare declaration carries no decorators (no false positives).
      const plain = by('plain');
      expect(plain?.decorators ?? []).not.toContain('Composable');
    } finally {
      reader.close();
    }
  });

  it('keeps Kotlin Multiplatform expect/actual markers alongside annotations', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-kmp-'));
    const cg = index(
      tmp,
      'app/src/androidMain/kotlin/com/x/Platform.kt',
      'package com.x\n' +
        'actual fun currentPlatform(): String = "android"\n'
    );
    await cg.indexAll();
    cg.close();

    const reader = CodeSymbolGraph.open(tmp);
    try {
      const fn = reader.getAllNodes().find((n) => n.name === 'currentPlatform');
      expect(fn?.decorators).toContain('actual');
    } finally {
      reader.close();
    }
  });
});
