/**
 * T1–T4 · symbol-level target-side verification via ArkAnalyzer.
 *
 * Realizes the phase-2 acceptance criteria (plan §验证 #2) on a HAND-WRITTEN,
 * valid multi-file HarmonyOS module:
 *   - reconstructed exports / ViewTree screens / capabilities are non-empty,
 *   - removing an export → interface fidelity reports the gap,
 *   - removing an `@ohos.net.http` import → capability diff `missingInTarget`
 *     hits `network`.
 * All ArkAnalyzer-backed cases are gated on the optional dep being installed;
 * the pure fidelity check runs unconditionally.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ArkExport,
  buildArkTargetGraph,
  isArkAnalyzerAvailable,
} from '../../src/migration/verify/arkanalyzer';
import { interfaceFidelity, verifyMigration } from '../../src/migration/verify/diff';
import { emptyMigrationGraph, mergeInto, MigrationGraph } from '../../src/migration/types';
import { AppNode, makeNodeId, capabilityMatchKey } from '../../src/migration/schema';

const INDEX_ETS = `import http from '@ohos.net.http';
import { UserService } from '../services/UserService';

@Entry
@Component
struct Index {
  @State message: string = 'Hello';
  private svc: UserService = new UserService();

  build() {
    Column() {
      Text(this.message).fontSize(20)
      Button('Load').onClick(() => { this.svc.fetchUser(); })
    }.width('100%')
  }
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

/** Write a toy HarmonyOS module; `withNetwork=false` drops the http import. */
function writeToyModule(withNetwork = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-toy-'));
  const ets = path.join(root, 'entry/src/main/ets');
  fs.mkdirSync(path.join(ets, 'pages'), { recursive: true });
  fs.mkdirSync(path.join(ets, 'services'), { recursive: true });
  fs.mkdirSync(path.join(ets, 'data'), { recursive: true });

  const userService = withNetwork
    ? USERSERVICE_ETS
    : USERSERVICE_ETS.replace(/import http[^\n]*\n/, '').replace(
        /const req[^\n]*\n\s*const resp[^\n]*\n\s*return resp\.result as string;/,
        "return 'stub';"
      );
  const index = withNetwork ? INDEX_ETS : INDEX_ETS.replace(/import http[^\n]*\n/, '');

  fs.writeFileSync(path.join(ets, 'pages/Index.ets'), index, 'utf8');
  fs.writeFileSync(path.join(ets, 'services/UserService.ets'), userService, 'utf8');
  fs.writeFileSync(path.join(ets, 'data/PrefsStore.ets'), PREFS_ETS, 'utf8');
  return root;
}

describe('T3 · interface fidelity (pure, no ArkAnalyzer)', () => {
  it('flags source members with no corresponding target export', () => {
    const exports: ArkExport[] = [
      { name: 'UserService', kind: 'class', signature: 'UserService', file: 'a.ets', isComponent: false },
      { name: 'prefsstore', kind: 'class', signature: 'prefsstore', file: 'b.ets', isComponent: false },
    ];
    const f = interfaceFidelity('m', ['UserService', 'PrefsStore', 'RepoImpl'], exports);
    // PrefsStore matches case-insensitively; RepoImpl has no target → missing.
    expect(f.missing).toEqual(['RepoImpl']);
    expect(f.matchedCount).toBe(2);
    expect(f.sourceCount).toBe(3);
  });
});

describe('T2 · symbol-level target reconstruction (needs ArkAnalyzer)', () => {
  it.runIf(isArkAnalyzerAvailable())('recovers exports, ViewTree screens, capabilities', () => {
    const root = writeToyModule(true);
    try {
      const g = buildArkTargetGraph(root)!;
      expect(g).not.toBeNull();
      expect(g.structural.buildOk).toBe(true);

      const capIds = g.capabilityNodes.map((n) => n.name).sort();
      expect(capIds).toContain('network'); // @ohos.net.http
      expect(capIds).toContain('persistence.datastore'); // @ohos.data.preferences
      expect(capIds).toContain('ui.declarative'); // @Component struct

      // @Entry Index struct → a Screen node.
      expect(g.screenNodes.some((s) => s.name === 'Index')).toBe(true);
      // Exported classes recovered.
      const exportNames = g.exports.map((e) => e.name);
      expect(exportNames).toContain('UserService');
      expect(exportNames).toContain('PrefsStore');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(isArkAnalyzerAvailable())('is deterministic across two builds', () => {
    const root = writeToyModule(true);
    try {
      const a = buildArkTargetGraph(root)!;
      const b = buildArkTargetGraph(root)!;
      expect(a.capabilityNodes.map((n) => n.id)).toEqual(b.capabilityNodes.map((n) => n.id));
      expect(a.screenNodes.map((n) => n.id)).toEqual(b.screenNodes.map((n) => n.id));
      expect(a.exports.map((e) => e.name)).toEqual(b.exports.map((e) => e.name));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('T3/T4 · capability diff via verifyMigration (needs ArkAnalyzer)', () => {
  it.runIf(isArkAnalyzerAvailable())('reports network as missingInTarget when the import is removed', () => {
    const reduced = writeToyModule(false); // no @ohos.net.http
    try {
      const graph = graphWithSourceCapability('network');
      const result = verifyMigration(graph, reduced);
      expect(result.method).toBe('arkanalyzer');
      expect(result.structural?.buildOk).toBe(true);
      // Source uses network, target no longer imports it → a real gap.
      expect(result.report.capabilities.missingInTarget).toContain('network');
    } finally {
      fs.rmSync(reduced, { recursive: true, force: true });
    }
  });

  it.runIf(isArkAnalyzerAvailable())('matches network (maps_to) when the import is present', () => {
    const full = writeToyModule(true);
    try {
      const graph = graphWithSourceCapability('network');
      const result = verifyMigration(graph, full);
      expect(result.report.capabilities.matched).toContain('network');
      expect(result.report.capabilities.missingInTarget).not.toContain('network');
      expect(result.mapsToEdges.length).toBeGreaterThan(0);

      // T3 · the source module's persisted publicInterface is fully covered
      // by the target exports (UserService/PrefsStore), scoped by module path.
      const fidelity = result.fidelity.find((f) => f.moduleName === ':entry');
      expect(fidelity?.missing).toEqual([]);
      expect(fidelity?.scope).toBe('module-path');
    } finally {
      fs.rmSync(full, { recursive: true, force: true });
    }
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
