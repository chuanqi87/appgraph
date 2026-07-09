/**
 * End-to-end tests for the web UI's JSON API (src/webui/server.ts +
 * routes/*.ts). Exercises a real indexed CodeGraph project and a synthetic
 * AppGraph document over real HTTP — no mocking, per repo convention.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../src';
import { startWebUiServer, WebUiServer } from '../../src/webui/server';
import { writeAppGraph } from '../../src/appgraph/build';
import { appGraphPath } from '../../src/appgraph/paths';
import type { AppGraph } from '../../src/appgraph/schema';

async function getJson(url: string): Promise<{ status: number; body: any }> {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
}

describe('web UI server', () => {
  let tempDir: string;
  let server: WebUiServer | null = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-webui-'));
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports codegraph.indexed=false and appgraph.built=false on a fresh project', async () => {
    server = await startWebUiServer(tempDir, { port: 0, open: false });
    const { status, body } = await getJson(`${server.url}api/status`);
    expect(status).toBe(200);
    expect(body.codegraph.indexed).toBe(false);
    expect(body.codegraph.stats).toBeNull();
    expect(body.appgraph.built).toBe(false);
  });

  it('codegraph endpoints report a not-indexed guidance message (200, not an HTTP error) before indexing', async () => {
    server = await startWebUiServer(tempDir, { port: 0, open: false });
    const nodes = await getJson(`${server.url}api/codegraph/nodes`);
    expect(nodes.status).toBe(200);
    expect(typeof nodes.body.error).toBe('string');
    expect(nodes.body.error).toContain('codegraph init');
  });

  it('appgraph endpoints report a not-built guidance message (200, not an HTTP error) before building', async () => {
    server = await startWebUiServer(tempDir, { port: 0, open: false });
    const graph = await getJson(`${server.url}api/appgraph/graph`);
    expect(graph.status).toBe(200);
    expect(typeof graph.body.error).toBe('string');
    expect(graph.body.error).toContain('appgraph build');
  });

  describe('against an indexed project', () => {
    beforeEach(async () => {
      fs.writeFileSync(
        path.join(tempDir, 'a.ts'),
        'export function helper(): number { return 1; }\n'
      );
      fs.writeFileSync(
        path.join(tempDir, 'b.ts'),
        'import { helper } from "./a";\nexport function main(): number { return helper(); }\n'
      );
      const cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();
      cg.close();
    });

    it('exposes GraphStats via /api/status and /api/codegraph/stats', async () => {
      server = await startWebUiServer(tempDir, { port: 0, open: false });
      const status = await getJson(`${server.url}api/status`);
      expect(status.body.codegraph.indexed).toBe(true);
      expect(status.body.codegraph.stats.nodeCount).toBeGreaterThan(0);

      const stats = await getJson(`${server.url}api/codegraph/stats`);
      expect(stats.body.stats.fileCount).toBe(2);
    });

    it('searches/filters nodes and returns a node detail with resolved incoming/outgoing edges', async () => {
      server = await startWebUiServer(tempDir, { port: 0, open: false });

      const search = await getJson(`${server.url}api/codegraph/nodes?kind=function&q=main`);
      expect(search.status).toBe(200);
      const mainResult = search.body.results.find((r: any) => r.node.name === 'main');
      expect(mainResult).toBeDefined();

      const detail = await getJson(`${server.url}api/codegraph/nodes/${encodeURIComponent(mainResult.node.id)}`);
      expect(detail.status).toBe(200);
      expect(detail.body.node.name).toBe('main');
      // main() calls helper() — an outgoing edge whose "other" side resolves
      // to the real helper node (not just a bare source/target id pair).
      const callsHelper = detail.body.outgoing.find((e: any) => e.other?.name === 'helper');
      expect(callsHelper).toBeDefined();
      expect(callsHelper.edge.kind).toBe('calls');
    });

    it('404s for an unknown node id instead of a generic 500', async () => {
      server = await startWebUiServer(tempDir, { port: 0, open: false });
      const res = await getJson(`${server.url}api/codegraph/nodes/does-not-exist`);
      expect(res.status).toBe(404);
    });

    it('lists files with pagination totals', async () => {
      server = await startWebUiServer(tempDir, { port: 0, open: false });
      const res = await getJson(`${server.url}api/codegraph/files?limit=1`);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
      expect(res.body.files).toHaveLength(1);
    });

    it('lists edges filtered by kind, enriched with source/target summaries', async () => {
      server = await startWebUiServer(tempDir, { port: 0, open: false });
      const res = await getJson(`${server.url}api/codegraph/edges?kind=calls`);
      expect(res.status).toBe(200);
      expect(res.body.total).toBeGreaterThan(0);
      const first = res.body.edges[0];
      expect(first.edge.kind).toBe('calls');
      expect(first.source).not.toBeNull();
      expect(first.target).not.toBeNull();
    });

    it('returns a JSON-serializable array for subgraph nodes (Map does not survive JSON.stringify)', async () => {
      server = await startWebUiServer(tempDir, { port: 0, open: false });
      const search = await getJson(`${server.url}api/codegraph/nodes?q=main&kind=function`);
      const mainId = search.body.results[0].node.id;

      const res = await getJson(`${server.url}api/codegraph/subgraph?start=${encodeURIComponent(mainId)}&mode=impact&depth=2`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.nodes)).toBe(true);
      expect(Array.isArray(res.body.edges)).toBe(true);
      expect(res.body.nodes.length).toBeGreaterThan(0);
    });

    it('caps subgraph size at the requested limit', async () => {
      server = await startWebUiServer(tempDir, { port: 0, open: false });
      const search = await getJson(`${server.url}api/codegraph/nodes?q=main&kind=function`);
      const mainId = search.body.results[0].node.id;

      const res = await getJson(
        `${server.url}api/codegraph/subgraph?start=${encodeURIComponent(mainId)}&mode=traverse&depth=3&limit=1`
      );
      expect(res.status).toBe(200);
      expect(res.body.nodes.length).toBeLessThanOrEqual(1);
    });
  });

  describe('against a built AppGraph', () => {
    let helperNodeId: string;

    beforeEach(async () => {
      fs.writeFileSync(
        path.join(tempDir, 'a.ts'),
        'export function helper(): number { return 1; }\n'
      );
      const cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();
      const [node] = cg.getNodesByName('helper');
      helperNodeId = node.id;
      cg.close();

      const graph: AppGraph = {
        schemaVersion: 1,
        platform: 'android',
        app: { name: 'demo', packageName: 'com.demo.app' },
        fidelity: 'source-project',
        supportedKinds: ['ArchModule', 'Capability'],
        nodes: [
          {
            id: 'app-node-1',
            kind: 'ArchModule',
            matchKey: 'module::app',
            name: ':app',
            platform: 'android',
            provenance: 'manifest',
            fidelity: 'source-project',
            confidence: 1,
            platformRef: { file: 'a.ts', symbol: 'helper' },
          },
          {
            id: 'app-node-2',
            kind: 'Capability',
            matchKey: 'capability:network',
            name: 'network',
            platform: 'android',
            provenance: 'manifest',
            fidelity: 'source-project',
            confidence: 1,
          },
        ],
        edges: [
          {
            id: 'edge-1',
            kind: 'uses_capability',
            from: 'app-node-1',
            to: 'app-node-2',
            provenance: 'manifest',
            confidence: 1,
          },
        ],
        coverageWarnings: [{ message: 'example warning' }],
      };
      writeAppGraph(appGraphPath(tempDir), graph);
    });

    it('reports appgraph.built=true and returns the full document', async () => {
      server = await startWebUiServer(tempDir, { port: 0, open: false });
      const status = await getJson(`${server.url}api/status`);
      expect(status.body.appgraph.built).toBe(true);

      const graph = await getJson(`${server.url}api/appgraph/graph`);
      expect(graph.status).toBe(200);
      expect(graph.body.graph.nodes).toHaveLength(2);
      expect(graph.body.graph.coverageWarnings).toHaveLength(1);
    });

    it('returns an AppNode detail with resolved edges and a CodeGraph drill-down match', async () => {
      server = await startWebUiServer(tempDir, { port: 0, open: false });
      const res = await getJson(`${server.url}api/appgraph/nodes/app-node-1`);
      expect(res.status).toBe(200);
      expect(res.body.node.name).toBe(':app');
      expect(res.body.outgoing).toHaveLength(1);
      expect(res.body.outgoing[0].other.name).toBe('network');
      // platformRef {file:'a.ts', symbol:'helper'} should resolve to the real
      // CodeGraph node for `helper`.
      expect(res.body.drillDown.some((d: any) => d.id === helperNodeId)).toBe(true);
    });

    it('404s for an unknown AppNode id', async () => {
      server = await startWebUiServer(tempDir, { port: 0, open: false });
      const res = await getJson(`${server.url}api/appgraph/nodes/does-not-exist`);
      expect(res.status).toBe(404);
    });
  });
});
