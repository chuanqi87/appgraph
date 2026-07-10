/**
 * P3.2b · widen data-model + reactive-flow extraction to the SQL/RxJava stack.
 *
 * Four families that the class-driven entity pass could not see:
 *   1. SQLDelight `.sq` `CREATE TABLE` schemas (filesystem-driven DataModels).
 *   2. Handwritten SQLite (`SQLiteOpenHelper`) → a per-module brief HINT, never a
 *      DataModel (so it can't manufacture a false V2 entity gap).
 *   3. Moshi `@JsonClass` / `@Parcelize` (Kotlin) + Java `implements Serializable`
 *      POJO field schemas (entity gate widening).
 *   4. RxJava exposed streams (Java return types + Kotlin) in the reactive flows.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Node, NodeKind } from '../../src/types';
import { ReadCode, DetectContext } from '../../src/appgraph/detect/shared';
import {
  parseCreateTables,
  detectSqlDelightModels,
  detectSqliteSchemaHints,
} from '../../src/appgraph/detect/sqldelight';
import { detectEntities, FieldSchema } from '../../src/appgraph/detect/entities';
import { detectFlows } from '../../src/appgraph/detect/flows';
import { javaFields } from '../../src/appgraph/detect/java-source';
import { renderUnitBrief } from '../../src/migration/plan/brief';

interface Spec {
  kind: NodeKind;
  name: string;
  module: string;
  code: string;
  lang?: 'kotlin' | 'java';
}
interface Fixture {
  nodes: Node[];
  readCode: ReadCode;
  ctx: DetectContext;
}

let seq = 0;
function buildFixture(specs: Spec[]): Fixture {
  const store = new Map<string, string>();
  const moduleOf = new Map<string, string>();
  const nodes = specs.map((s) => {
    const id = `n${seq++}`;
    store.set(id, s.code);
    moduleOf.set(id, `mod:${s.module}`);
    const lang = s.lang ?? 'kotlin';
    const ext = lang === 'java' ? 'java' : 'kt';
    const filePath = `${s.module}/src/main/${lang}/${s.name}.${ext}`;
    return {
      id,
      kind: s.kind,
      name: s.name,
      qualifiedName: `${filePath}::${s.name}`,
      filePath,
      language: lang,
      startLine: 1,
      endLine: 1 + s.code.split('\n').length,
      startColumn: 0,
      endColumn: 0,
      updatedAt: 0,
    } as Node;
  });
  const modules = [...new Set(specs.map((s) => s.module))];
  const ctx: DetectContext = {
    nodeToModuleId: moduleOf,
    moduleNameById: new Map(modules.map((m) => [`mod:${m}`, m])),
    archModules: modules.map((m) => ({
      id: `mod:${m}`,
      kind: 'ArchModule' as const,
      matchKey: `module:${m}`,
      name: m,
      platform: 'android' as const,
      provenance: 'lifted' as const,
      fidelity: 'source-project' as const,
      confidence: 1,
      attrs: { dir: m },
    })),
  };
  return { nodes, readCode: (n) => store.get(n.id) ?? null, ctx };
}

// ── 1 · SQLDelight `.sq` CREATE TABLE parser ────────────────────────────────
describe('P3.2b·1 · parseCreateTables', () => {
  const serviceSq = [
    'import kotlin.time.Instant;',
    'import kotlin.Int;',
    '',
    '-- Delete old tables db',
    'DROP TABLE IF EXISTS items;',
    '',
    'CREATE TABLE IF NOT EXISTS catchUpDbItem (',
    '  id INTEGER NOT NULL PRIMARY KEY,',
    '  title TEXT NOT NULL,',
    '  timestamp INTEGER AS Instant,',
    '  score INTEGER AS Int,',
    '  -- By default, the icon used is a comment icon if this is null',
    '  markType TEXT',
    ');',
    '',
    'insertRemoteKey:',
    'INSERT OR REPLACE INTO remoteKeys (serviceId, nextPageKey) VALUES (?, ?);',
  ].join('\n');

  it('parses columns, AS adapters, inline PK, NOT NULL and comment-with-comma', () => {
    const tables = parseCreateTables(serviceSq);
    expect(tables.map((t) => t.name)).toEqual(['catchUpDbItem']);
    const t = tables[0]!;
    expect(t.fields.map((f) => f.name)).toEqual(['id', 'title', 'timestamp', 'score', 'markType']);
    const byName = new Map(t.fields.map((f) => [f.name, f]));
    expect(byName.get('id')!.primaryKey).toBe(true);
    expect(byName.get('id')!.nullable).toBe(false);
    expect(byName.get('title')!.nullable).toBe(false);
    // `AS Instant` / `AS Int` supply the Kotlin-adapted type, not the raw SQL type.
    expect(byName.get('timestamp')!.type).toBe('Instant');
    expect(byName.get('score')!.type).toBe('Int');
    // A column with neither NOT NULL nor PRIMARY KEY is nullable.
    expect(byName.get('markType')!.nullable).toBe(true);
    expect(byName.get('markType')!.type).toBe('TEXT');
  });

  it('applies a table-level PRIMARY KEY(col) to the named column', () => {
    const tables = parseCreateTables(
      'CREATE TABLE IF NOT EXISTS unfurls (\n  url TEXT NOT NULL,\n  title TEXT,\n  PRIMARY KEY(url)\n);'
    );
    const t = tables[0]!;
    expect(t.name).toBe('unfurls');
    expect(t.fields.map((f) => f.name)).toEqual(['url', 'title']);
    expect(t.fields.find((f) => f.name === 'url')!.primaryKey).toBe(true);
    expect(t.fields.find((f) => f.name === 'title')!.primaryKey).toBe(false);
  });

  it('handles a single-line table and multiple tables in one file', () => {
    const tables = parseCreateTables(
      'CREATE TABLE gemoji (alias TEXT NOT NULL, emoji TEXT, PRIMARY KEY(alias));\n' +
        'CREATE TABLE remoteKeys (serviceId TEXT NOT NULL PRIMARY KEY, nextPageKey TEXT);'
    );
    expect(tables.map((t) => t.name)).toEqual(['gemoji', 'remoteKeys']);
    expect(tables[0]!.fields.map((f) => f.name)).toEqual(['alias', 'emoji']);
    expect(tables[1]!.fields.find((f) => f.name === 'serviceId')!.primaryKey).toBe(true);
  });
});

describe('P3.2b·1 · detectSqlDelightModels (filesystem)', () => {
  it('emits a DataModel node + app_contains edge per `.sq` table', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqld-'));
    try {
      const dir = path.join(root, 'bookmarks/db/src/commonMain/sqldelight/catchup');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'bookmarks.sq'),
        'import kotlin.time.Instant;\n\n' +
          'CREATE TABLE IF NOT EXISTS bookmark (\n' +
          '  id INTEGER NOT NULL PRIMARY KEY,\n' +
          '  timestamp INTEGER AS Instant NOT NULL\n' +
          ');\n\naddBookmark:\nINSERT INTO bookmark (id, timestamp) VALUES (?, ?);\n'
      );
      const modules = [{ id: 'mod:bookmarks/db', name: ':bookmarks:db', dir: 'bookmarks/db' }];
      const res = detectSqlDelightModels(root, modules);
      expect(res.stats.tables).toBe(1);
      expect(res.dataModelNodes).toHaveLength(1);
      const node = res.dataModelNodes[0]!;
      expect(node.kind).toBe('DataModel');
      expect(node.name).toBe('bookmark');
      expect(node.subtype).toBe('sqldelight-table');
      expect(node.attrs!.framework).toBe('sqldelight');
      expect(node.attrs!.tableName).toBe('bookmark');
      const fields = node.attrs!.fields as FieldSchema[];
      expect(fields.map((f) => f.name)).toEqual(['id', 'timestamp']);
      expect(fields.find((f) => f.name === 'timestamp')!.type).toBe('Instant');
      // Attributed to the owning module.
      expect(res.containsEdges).toHaveLength(1);
      expect(res.containsEdges[0]!.from).toBe('mod:bookmarks/db');
      expect(res.containsEdges[0]!.to).toBe(node.id);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('is deterministic — two scans produce byte-identical nodes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqld2-'));
    try {
      const dir = path.join(root, 'db/src/commonMain/sqldelight');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'a.sq'), 'CREATE TABLE foo (x TEXT NOT NULL PRIMARY KEY, y TEXT);');
      const a = detectSqlDelightModels(root, []);
      const b = detectSqlDelightModels(root, []);
      expect(JSON.stringify(a.dataModelNodes)).toBe(JSON.stringify(b.dataModelNodes));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── 2 · Handwritten SQLite → per-module hint (NOT a DataModel) ──────────────
describe('P3.2b·2 · detectSqliteSchemaHints', () => {
  const podDbAdapter = [
    'public class PodDBAdapter {',
    '    public static final String TABLE_NAME_FEEDS = "Feeds";',
    '    public static final String TABLE_NAME_FEED_ITEMS = "FeedItems";',
    '    public static final String KEY_ID = "id";',
    '    public static final String KEY_TITLE = "title";',
    '    public static final String KEY_LINK = "link";',
    '    private static final String CREATE_TABLE_FEEDS = "CREATE TABLE " + TABLE_NAME_FEEDS + " ("',
    '            + KEY_ID + " INTEGER PRIMARY KEY," + KEY_TITLE + " TEXT)";',
    '    private static final String CREATE_TABLE_FEED_ITEMS = "CREATE TABLE " + TABLE_NAME_FEED_ITEMS',
    '            + " (" + KEY_ID + " INTEGER PRIMARY KEY," + KEY_LINK + " TEXT)";',
    '    public void onCreate(SQLiteDatabase db) {',
    '        db.execSQL(CREATE_TABLE_FEEDS);',
    '        db.execSQL(CREATE_TABLE_FEED_ITEMS);',
    '    }',
    '}',
  ].join('\n');

  it('resolves table names + KEY_* column inventory from constant concatenation', () => {
    const f = buildFixture([{ kind: 'class', name: 'PodDBAdapter', module: 'storage', lang: 'java', code: podDbAdapter }]);
    const res = detectSqliteSchemaHints(f.nodes, f.readCode, f.ctx);
    const hint = res.hintsByModule.get('mod:storage')!;
    expect(hint.tables).toEqual(['FeedItems', 'Feeds']);
    expect(hint.columns).toEqual(['id', 'link', 'title']);
    expect(hint.files).toEqual(['storage/src/main/java/PodDBAdapter.java']);
    expect(res.stats.ownerClasses).toBe(1);
  });

  it('emits NO DataModel node for the handwritten adapter (no false V2 gap)', () => {
    const f = buildFixture([{ kind: 'class', name: 'PodDBAdapter', module: 'storage', lang: 'java', code: podDbAdapter }]);
    // The adapter is behavior-named + fieldless-of-data → never a DataModel.
    expect(detectEntities(f.nodes, f.readCode, f.ctx).dataModelNodes).toHaveLength(0);
  });

  it('ignores a class that has no CREATE TABLE / SQLite API', () => {
    const f = buildFixture([
      { kind: 'class', name: 'Plain', module: 'm', lang: 'java', code: 'class Plain { String KEY_X = "x"; }' },
    ]);
    expect(detectSqliteSchemaHints(f.nodes, f.readCode, f.ctx).hintsByModule.size).toBe(0);
  });
});

// ── 3 · Moshi / Parcelize (Kotlin) + Java POJO field schemas ────────────────
describe('P3.2b·3 · javaFields', () => {
  it('extracts instance fields, skips statics/methods, primitives are non-null', () => {
    const code = [
      'public class Feed implements Serializable {',
      '    public static final String TAG = "feed";',
      '    private long id;',
      '    public String title;',
      '    private List<FeedItem> items;',
      '    private boolean paged;',
      '    public Feed(long id) { this.id = id; }',
      '    public String getTitle() { return title; }',
      '}',
    ].join('\n');
    const fields = javaFields(code);
    expect(fields.map((f) => f.name)).toEqual(['id', 'title', 'items', 'paged']);
    const byName = new Map(fields.map((f) => [f.name, f]));
    expect(byName.get('id')!.type).toBe('long');
    expect(byName.get('id')!.nullable).toBe(false); // primitive
    expect(byName.get('title')!.nullable).toBe(true); // reference type
    expect(byName.get('items')!.type).toBe('List<FeedItem>');
  });

  it('carries per-field annotations through to toFieldSchema (PrimaryKey)', () => {
    const code = 'class T { @PrimaryKey private int uid; private String name; }';
    const fields = javaFields(code);
    expect(fields.find((f) => f.name === 'uid')!.annotations).toContain('PrimaryKey');
  });
});

describe('P3.2b·3 · detectEntities gate widening', () => {
  it('recognizes Moshi @JsonClass and @Parcelize (Kotlin), with framework tags', () => {
    const f = buildFixture([
      {
        kind: 'class',
        name: 'ApiUser',
        module: 'net',
        code: '@JsonClass(generateAdapter = true)\ndata class ApiUser(val id: String, @Json(name = "full_name") val name: String)',
      },
      {
        kind: 'class',
        name: 'RouteArgs',
        module: 'app',
        code: '@Parcelize\ndata class RouteArgs(val id: Long) : Parcelable',
      },
    ]);
    const models = detectEntities(f.nodes, f.readCode, f.ctx).dataModelNodes;
    const byName = new Map(models.map((m) => [m.name, m]));
    expect(byName.get('ApiUser')!.attrs!.framework).toBe('moshi');
    expect(byName.get('ApiUser')!.subtype).toBe('serializable');
    expect(byName.get('RouteArgs')!.attrs!.framework).toBe('parcelize');
  });

  it('recognizes an un-annotated Java POJO that implements Serializable', () => {
    const f = buildFixture([
      {
        kind: 'class',
        name: 'FeedFunding',
        module: 'model',
        lang: 'java',
        code: 'public class FeedFunding implements Serializable {\n  public String url;\n  public String content;\n  public void setUrl(String u) { this.url = u; }\n}',
      },
    ]);
    const models = detectEntities(f.nodes, f.readCode, f.ctx).dataModelNodes;
    expect(models.map((m) => m.name)).toEqual(['FeedFunding']);
    expect(models[0]!.attrs!.framework).toBe('java-pojo');
    expect((models[0]!.attrs!.fields as FieldSchema[]).map((x) => x.name)).toEqual(['url', 'content']);
  });

  it('does NOT treat behavior-named or fieldless Serializable classes as models', () => {
    const f = buildFixture([
      // behavior-named → excluded even though it implements Serializable.
      { kind: 'class', name: 'DownloadService', module: 'm', lang: 'java', code: 'class DownloadService implements Serializable { private int state; }' },
      // fieldless → excluded (no schema to migrate).
      { kind: 'class', name: 'Marker', module: 'm', lang: 'java', code: 'class Marker implements Serializable { void go() {} }' },
      // plain class, no data signal → excluded.
      { kind: 'class', name: 'Helper', module: 'm', lang: 'java', code: 'class Helper { private String s; }' },
    ]);
    expect(detectEntities(f.nodes, f.readCode, f.ctx).dataModelNodes).toHaveLength(0);
  });
});

// ── 4 · RxJava exposed streams ──────────────────────────────────────────────
describe('P3.2b·4 · detectFlows RxJava', () => {
  it('detects Java method return types + fields, ignoring method-body locals', () => {
    const f = buildFixture([
      {
        kind: 'class',
        name: 'Searcher',
        module: 'discovery',
        lang: 'java',
        code: [
          'public class Searcher {',
          '    private final PublishSubject<Event> events = PublishSubject.create();',
          '    public Single<List<PodcastSearchResult>> search(String query) {',
          '        Single<String> local = api.lookup(query);', // a local → NOT exposed
          '        return local.map(x -> parse(x)).subscribe();',
          '    }',
          '}',
        ].join('\n'),
      },
    ]);
    const facts = detectFlows(f.nodes, f.readCode, f.ctx).flowsByModule.get('mod:discovery')!;
    const byName = new Map(facts.exposedStates.map((s) => [s.name, s]));
    expect([...byName.keys()].sort()).toEqual(['events', 'search']);
    expect(byName.get('search')!.flowKind).toBe('Single');
    expect(byName.get('search')!.type).toBe('List<PodcastSearchResult>');
    expect(byName.get('events')!.flowKind).toBe('PublishSubject');
    expect(byName.has('local')).toBe(false); // local decl inside the body is skipped
    expect(facts.collectPoints).toBeGreaterThan(0); // `.subscribe(`
  });

  it('detects a Kotlin function that returns a Flow (return-type exposure)', () => {
    const f = buildFixture([
      { kind: 'method', name: 'observeItems', module: 'repo', code: 'fun observeItems(): Flow<List<Item>> = dao.all()' },
      { kind: 'class', name: 'Repo', module: 'repo', code: 'class Repo {\n  val stream: Observable<Feed> = subject\n}' },
    ]);
    const facts = detectFlows(f.nodes, f.readCode, f.ctx).flowsByModule.get('mod:repo')!;
    const byName = new Map(facts.exposedStates.map((s) => [s.name, s]));
    expect(byName.get('observeItems')!).toMatchObject({ flowKind: 'Flow', type: 'List<Item>' });
    expect(byName.get('stream')!).toMatchObject({ flowKind: 'Observable', type: 'Feed' });
  });
});

// ── 5 · brief rendering ─────────────────────────────────────────────────────
describe('P3.2b·5 · brief rendering', () => {
  const baseModule = () => ({
    moduleId: 'm',
    moduleName: ':storage:database',
    files: [],
    publicInterface: [],
    capabilities: [],
    dependencies: [],
    testDependencies: [],
    impliedDependencies: [],
    screens: [],
    dataModels: [],
    customViews: [],
    featureSections: [],
    permissionCapabilities: [],
    backgroundComponents: [],
    appEntries: [],
    deeplinks: [],
  });

  it('renders a handwritten-SQLite hint section (tables + column keys)', () => {
    const md = renderUnitBrief(
      { order: 0, label: ':storage:database', cyclic: false, moduleIds: ['m'] },
      [
        {
          ...baseModule(),
          sqliteSchema: {
            tables: ['FeedItems', 'Feeds'],
            columns: ['id', 'link', 'title'],
            files: ['storage/PodDBAdapter.java'],
          },
        } as any,
      ],
      5
    );
    expect(md).toContain('### 手写 SQLite 表 [启发]');
    expect(md).toContain('表(2):FeedItems, Feeds');
    expect(md).toContain('列键');
    expect(md).toContain('storage/PodDBAdapter.java');
  });

  it('renders a SQLDelight table DataModel as an RDB table (not an interface)', () => {
    const md = renderUnitBrief(
      { order: 0, label: ':db', cyclic: false, moduleIds: ['m'] },
      [
        {
          ...baseModule(),
          dataModels: [
            {
              name: 'bookmark',
              subtype: 'sqldelight-table',
              tableName: 'bookmark',
              file: 'db/bookmarks.sq',
              fields: [{ name: 'id', type: 'Long', nullable: false, primaryKey: true, hasDefault: false }],
            },
          ],
        } as any,
      ],
      5
    );
    expect(md).toContain('bookmark → RDB 表 `bookmark` — db/bookmarks.sq');
  });
});
