/**
 * M4 · TARGET-side reconstruction via the community tree-sitter index.
 *
 * The target half is now symmetric with the source half: `resolveTargetSurface`
 * indexes the generated HarmonyOS output with the SAME `.ets` arkts extractor and
 * projects it to the acceptance surface. These lock, end-to-end on a hand-written
 * multi-file module:
 *   - capabilities from real `@ohos.*` imports, screens from `@Entry` structs,
 *     exports (with fields) from exported classes,
 *   - router route literals → navigation edges (the one thing the graph itself
 *     doesn't emit),
 *   - the result is deterministic across an index + a re-open,
 *   - `verifyMigration` reports `network` matched/missing off the real imports,
 *   - and the pure `interfaceFidelity` name match (no index needed).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveTargetSurface, TargetSurface } from '../../src/migration/verify/target-graph';
import { interfaceFidelity, verifyMigration } from '../../src/migration/verify/diff';
import { emptyMigrationGraph, mergeInto, MigrationGraph } from '../../src/migration/types';
import { AppNode, makeNodeId, capabilityMatchKey } from '../../src/migration/schema';

const INDEX_ETS = `import { router } from '@kit.ArkUI';
import { UserService } from '../services/UserService';

@Entry
@Component
struct Index {
  @State message: string = 'Hello';
  private svc: UserService = new UserService();

  build() {
    Column() {
      Text(this.message).fontSize(20)
      Button('Detail').onClick(() => { router.pushUrl({ url: 'pages/Detail' }); })
    }.width('100%')
  }
}
`;

const DETAIL_ETS = `@Entry
@Component
struct Detail {
  build() { Column() { Text('detail') } }
}
`;

const USERSERVICE_ETS = `import http from '@ohos.net.http';

export class UserService {
  async fetchUser(): Promise<string> {
    const req = http.createHttp();
    const resp = await req.request('https://example.com/u');
    return resp.result as string;
  }
  greet(name: string): string { return 'hi ' + name; }
}
`;

const PREFS_ETS = `import dataPreferences from '@ohos.data.preferences';

export class PrefsStore {
  async save(key: string, value: string): Promise<void> {
    const store = await dataPreferences.getPreferences(globalThis as never, 'app');
    await store.put(key, value);
  }
}
`;

const USER_ETS = `export class User {
  id: number = 0;
  name: string = '';
}
`;

/** Write a toy HarmonyOS module; `withNetwork=false` drops the http import. */
function writeToyModule(withNetwork = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tgt-graph-'));
  const ets = path.join(root, 'entry/src/main/ets');
  fs.mkdirSync(path.join(ets, 'pages'), { recursive: true });
  fs.mkdirSync(path.join(ets, 'services'), { recursive: true });
  fs.mkdirSync(path.join(ets, 'data'), { recursive: true });
  fs.mkdirSync(path.join(ets, 'model'), { recursive: true });

  const userService = withNetwork
    ? USERSERVICE_ETS
    : USERSERVICE_ETS.replace(/import http[^\n]*\n/, '').replace(
        /const req[^\n]*\n\s*const resp[^\n]*\n\s*return resp\.result as string;/,
        "return 'stub';"
      );

  fs.writeFileSync(path.join(ets, 'pages/Index.ets'), INDEX_ETS, 'utf8');
  fs.writeFileSync(path.join(ets, 'pages/Detail.ets'), DETAIL_ETS, 'utf8');
  fs.writeFileSync(path.join(ets, 'services/UserService.ets'), userService, 'utf8');
  fs.writeFileSync(path.join(ets, 'data/PrefsStore.ets'), PREFS_ETS, 'utf8');
  fs.writeFileSync(path.join(ets, 'model/User.ets'), USER_ETS, 'utf8');
  return root;
}

describe('resolveTargetSurface · community tree-sitter projection', () => {
  let root = '';
  let surface: TargetSurface;

  beforeAll(async () => {
    root = writeToyModule(true);
    surface = await resolveTargetSurface(root);
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('indexes the target (structural.buildOk) with the codegraph method', () => {
    expect(surface.method).toBe('codegraph');
    expect(surface.structural.buildOk).toBe(true);
    expect(surface.structural.fileCount).toBeGreaterThan(0);
  });

  it('recovers capabilities from real @ohos.*/@kit.* imports', () => {
    const capIds = surface.capabilityNodes.map((n) => n.name);
    expect(capIds).toContain('network'); // @ohos.net.http
    expect(capIds).toContain('persistence.datastore'); // @ohos.data.preferences
    expect(capIds).toContain('ui.declarative'); // @Component structs
  });

  it('recovers @Entry structs as screens', () => {
    const names = surface.screenNodes.map((s) => s.name).sort();
    expect(names).toEqual(['Detail', 'Index']);
    expect(surface.screenNodes.every((s) => s.platform === 'harmony')).toBe(true);
  });

  it('recovers exported classes with their fields', () => {
    const byName = new Map(surface.exports.map((e) => [e.name, e]));
    expect([...byName.keys()]).toEqual(expect.arrayContaining(['UserService', 'PrefsStore', 'User']));
    expect(byName.get('User')?.fields).toEqual(['id', 'name']);
    expect(byName.get('User')?.kind).toBe('class');
  });

  it('recovers router route literals as navigation edges', () => {
    expect(surface.navEdges).toContainEqual({ from: 'Index', to: 'Detail' });
  });

  it('is deterministic across an index + a re-open (sync)', async () => {
    const again = await resolveTargetSurface(root);
    expect(again.capabilityNodes.map((n) => n.id)).toEqual(surface.capabilityNodes.map((n) => n.id));
    expect(again.screenNodes.map((n) => n.id)).toEqual(surface.screenNodes.map((n) => n.id));
    expect(again.exports.map((e) => e.name)).toEqual(surface.exports.map((e) => e.name));
    expect(again.navEdges).toEqual(surface.navEdges);
  });
});

describe('verifyMigration · capability diff off the real imports', () => {
  it('matches network (maps_to) when the import is present', async () => {
    const full = writeToyModule(true);
    try {
      const result = await verifyMigration(graphWithSourceCapability('network'), full);
      expect(result.method).toBe('codegraph');
      expect(result.structural.buildOk).toBe(true);
      expect(result.report.capabilities.matched).toContain('network');
      expect(result.report.capabilities.missingInTarget).not.toContain('network');
      expect(result.mapsToEdges.length).toBeGreaterThan(0);

      // T3 · the source module's persisted publicInterface (UserService/PrefsStore)
      // is fully covered by the target exports, scoped by module path.
      const fidelity = result.fidelity.find((f) => f.moduleName === ':entry');
      expect(fidelity?.missing).toEqual([]);
      expect(fidelity?.scope).toBe('module-path');
    } finally {
      fs.rmSync(full, { recursive: true, force: true });
    }
  });

  it('reports network as missingInTarget when the import is removed', async () => {
    const reduced = writeToyModule(false); // no @ohos.net.http
    try {
      const result = await verifyMigration(graphWithSourceCapability('network'), reduced);
      expect(result.report.capabilities.missingInTarget).toContain('network');
    } finally {
      fs.rmSync(reduced, { recursive: true, force: true });
    }
  });
});

describe('interfaceFidelity · pure name match (no index)', () => {
  it('flags source members with no corresponding target export', () => {
    const exports = [
      { name: 'UserService', kind: 'class' as const, signature: 'UserService', file: 'a.ets', isComponent: false, fields: [] },
      { name: 'prefsstore', kind: 'class' as const, signature: 'prefsstore', file: 'b.ets', isComponent: false, fields: [] },
    ];
    const f = interfaceFidelity('m', ['UserService', 'PrefsStore', 'RepoImpl'], exports);
    // PrefsStore matches case-insensitively; RepoImpl has no target → missing.
    expect(f.missing).toEqual(['RepoImpl']);
    expect(f.matchedCount).toBe(2);
    expect(f.sourceCount).toBe(3);
  });
});

/**
 * A minimal MigrationGraph: one source android capability + a source module
 * whose `attrs.publicInterface` (persisted by `migrate plan`) is the T3
 * interface-fidelity baseline.
 */
function graphWithSourceCapability(capId: string): MigrationGraph {
  const graph = emptyMigrationGraph({
    platform: 'android',
    app: { name: 'toy', packageName: 'com.toy' },
  });
  const srcCap: AppNode = {
    id: makeNodeId('android', 'Capability', capabilityMatchKey(capId as never)),
    kind: 'Capability',
    matchKey: capabilityMatchKey(capId as never),
    name: capId,
    platform: 'android',
    provenance: 'manifest',
    fidelity: 'source-project',
    confidence: 1,
  };
  const sourceModule: AppNode = {
    id: makeNodeId('android', 'ArchModule', 'module:entry'),
    kind: 'ArchModule',
    matchKey: 'module:entry',
    name: ':entry',
    platform: 'android',
    provenance: 'manifest',
    fidelity: 'source-project',
    confidence: 1,
    attrs: { publicInterface: ['UserService', 'PrefsStore'] },
  };
  mergeInto(graph, { nodes: [srcCap, sourceModule] });
  return graph;
}
