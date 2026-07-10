/**
 * `migrate label` CLI passthrough — same handler as the migrate_label MCP
 * tool, reached over plain Bash so an analysis agent doesn't need a live MCP
 * connection. --summary-file exists because shell-quoting a multi-line
 * string is failure-prone.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeNodeId } from '../../src/appgraph/schema';
import { emptyMigrationGraph, mergeInto } from '../../src/migration/types';
import { writeMigrationGraph, migrationGraphPath } from '../../src/migration/serialize';
import { getLabelsPath } from '../../src/migration/paths';
import { readLabelStore } from '../../src/migration/labels';
import { cmdLabel } from '../../src/migration/cli';

describe('migrate label (CLI passthrough)', () => {
  let root: string;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-label-cli-'));
    const graph = emptyMigrationGraph({ platform: 'android', app: { name: 'x', packageName: 'x' } });
    mergeInto(graph, {
      nodes: [
        {
          id: makeNodeId('android', 'Feature', 'feature:feedsig'),
          kind: 'Feature', matchKey: 'feature:feedsig', name: 'Feed', platform: 'android',
          subtype: 'subdivision', provenance: 'lifted', fidelity: 'source-project', confidence: 0.6,
          attrs: { sig: 'feedsig', role: 'subdivision', members: ['a.kt'] },
        },
      ],
    });
    writeMigrationGraph(migrationGraphPath(root), graph);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes a label via --summary', () => {
    cmdLabel(root, { target: 'feature', key: 'feedsig', name: '信息流', summary: '订阅内容页' });
    expect(readLabelStore(getLabelsPath(root))!.features['feedsig']).toMatchObject({
      name: '信息流', summary: '订阅内容页', provenance: 'llm',
    });
  });

  it('reads a multi-line summary from --summary-file (avoids shell-quoting issues)', () => {
    const summaryFile = path.join(root, 'summary.txt');
    fs.writeFileSync(summaryFile, '订阅内容的信息流页面。\n迁移要点:后台刷新依赖 WorkManager。', 'utf8');
    cmdLabel(root, { target: 'feature', key: 'feedsig', summaryFile });
    const entry = readLabelStore(getLabelsPath(root))!.features['feedsig']!;
    expect(entry.summary.split('\n')).toHaveLength(2);
  });

  it('rejects an invalid --target before touching the sidecar', () => {
    expect(() => cmdLabel(root, { target: 'bogus', key: 'feedsig', summary: 'x' })).toThrow('--target');
    expect(readLabelStore(getLabelsPath(root))).toBeNull();
  });

  it('requires --key', () => {
    expect(() => cmdLabel(root, { target: 'feature', key: '', summary: 'x' })).toThrow('--key');
  });

  it('requires --summary or --summary-file', () => {
    expect(() => cmdLabel(root, { target: 'feature', key: 'feedsig' })).toThrow('--summary');
  });
});
