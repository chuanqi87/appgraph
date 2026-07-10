/**
 * P1-3b · controlled LLM label write-back.
 *
 * The graph stays deterministic; semantic labels the calling agent writes back
 * live in a sidecar, gated by validateLabel — deliberately light (length-bounded,
 * control-byte clean, target must resolve; multi-line summaries are allowed).
 * A rejected write returns guidance, never isError, and never touches labels.json.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeNodeId } from '../../src/appgraph/schema';
import { emptyMigrationGraph, mergeInto } from '../../src/migration/types';
import { writeMigrationGraph, migrationGraphPath } from '../../src/migration/serialize';
import { getLabelsPath } from '../../src/migration/paths';
import { MigrateToolHandler } from '../../src/migration/mcp/tools';
import { validateLabel, readLabelStore, LABEL_SUMMARY_MAX } from '../../src/migration/labels';

describe('P1-3b · validateLabel quality gate', () => {
  it('normalizes a good label and stamps llm provenance', () => {
    const r = validateLabel({ name: '  Feed  ', summary: '  展示订阅信息流  ' });
    expect('entry' in r && r.entry).toMatchObject({ name: 'Feed', summary: '展示订阅信息流', provenance: 'llm' });
  });
  it('rejects empty, over-long, and control-byte content', () => {
    expect(validateLabel({ summary: '   ' })).toHaveProperty('error');
    expect(validateLabel({ summary: 'x'.repeat(LABEL_SUMMARY_MAX + 1) })).toHaveProperty('error');
    expect(validateLabel({ summary: 'has\x00null' })).toHaveProperty('error');
    expect(validateLabel({ name: 'a'.repeat(61), summary: 'ok' })).toHaveProperty('error');
    expect(validateLabel({ name: 'line1\nline2', summary: 'ok' })).toHaveProperty('error');
  });
  it('accepts a multi-line summary (functional + migration notes)', () => {
    const r = validateLabel({ summary: '订阅内容的信息流页面。\n迁移要点:依赖 WorkManager 后台刷新,鸿蒙侧建议用 WorkScheduler 替代。' });
    expect('entry' in r && r.entry.summary.split('\n')).toHaveLength(2);
  });
});

describe('P1-3b · migrate_label write-back', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-label-'));
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
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('writes a feature label resolved by sig and persists it to the sidecar', () => {
    const h = new MigrateToolHandler(root);
    const out = h.execute('migrate_label', { target: 'feature', key: 'feedsig', name: '信息流', summary: '订阅内容的信息流页面' });
    expect(out.isError).toBeFalsy();
    expect(out.content[0]!.text).toContain('已写回功能簇');
    const store = readLabelStore(getLabelsPath(root));
    expect(store!.features['feedsig']).toMatchObject({ name: '信息流', summary: '订阅内容的信息流页面', provenance: 'llm' });
  });

  it('resolves a feature by hub name too', () => {
    const h = new MigrateToolHandler(root);
    h.execute('migrate_label', { target: 'feature', key: 'Feed', summary: '信息流' });
    expect(readLabelStore(getLabelsPath(root))!.features['feedsig']!.summary).toBe('信息流');
  });

  it('returns guidance (not isError) and writes nothing for an unknown target', () => {
    const h = new MigrateToolHandler(root);
    const out = h.execute('migrate_label', { target: 'feature', key: 'nope', summary: 'x' });
    expect(out.isError).toBeFalsy();
    expect(out.content[0]!.text).toContain('未找到功能簇');
    expect(readLabelStore(getLabelsPath(root))).toBeNull();
  });

  it('returns guidance and writes nothing for an over-long summary', () => {
    const h = new MigrateToolHandler(root);
    const out = h.execute('migrate_label', { target: 'feature', key: 'feedsig', summary: 'x'.repeat(LABEL_SUMMARY_MAX + 5) });
    expect(out.isError).toBeFalsy();
    expect(out.content[0]!.text).toContain('未写入');
    expect(readLabelStore(getLabelsPath(root))).toBeNull();
  });

  it('shows the AI label in app_features once written', () => {
    const h = new MigrateToolHandler(root);
    h.execute('migrate_label', { target: 'feature', key: 'feedsig', name: '信息流', summary: '订阅内容页' });
    const out = h.execute('app_features', {});
    expect(out.content[0]!.text).toContain('〔AI:信息流 — 订阅内容页〕');
  });

  it('renders a multi-line summary as an indented block, not inline', () => {
    const h = new MigrateToolHandler(root);
    h.execute('migrate_label', {
      target: 'feature',
      key: 'feedsig',
      name: '信息流',
      summary: '订阅内容的信息流页面。\n迁移要点:后台刷新依赖 WorkManager。',
    });
    const text = h.execute('app_features', {}).content[0]!.text;
    expect(text).toContain('〔AI:信息流〕');
    expect(text).toContain('订阅内容的信息流页面。');
    expect(text).toContain('迁移要点:后台刷新依赖 WorkManager。');
  });
});
