/**
 * U · shared Kotlin source parsing.
 *
 * These pure functions are the foundation of every U-track detect pass (codegraph
 * leaves `Node.decorators` empty for Kotlin, so annotations/fields are recovered
 * from source spans). Lock their behaviour on the exact shapes seen in the real
 * samples: multi-line annotations with args, per-field annotations, generics,
 * nullability, `::class` inside annotation args, and default values.
 */

import { describe, it, expect } from 'vitest';
import {
  annotationArg,
  annotationPositionalArg,
  enumEntries,
  functionParts,
  hasInjectConstructor,
  leadingAnnotations,
  parsePrimaryConstructor,
  sanitizeKotlin,
  superTypes,
  topLevelConstants,
} from '../../src/appgraph/detect/kotlin-source';

describe('leadingAnnotations', () => {
  it('extracts the declaration annotations, not field/body ones', () => {
    const code = [
      '@Entity(',
      '    tableName = "topics",',
      ')',
      'data class TopicEntity(',
      '    @PrimaryKey val id: String,',
      ')',
    ].join('\n');
    expect(leadingAnnotations(code)).toEqual(['Entity']);
  });

  it('normalizes use-site targets and package qualifiers', () => {
    expect(leadingAnnotations('@field:JvmStatic\n@androidx.room.Dao\ninterface X')).toEqual([
      'JvmStatic',
      'Dao',
    ]);
  });

  it('is not fooled by `::class` inside an annotation argument', () => {
    const code = '@InstallIn(SingletonComponent::class)\nobject M';
    expect(leadingAnnotations(code)).toEqual(['InstallIn']);
  });

  it('handles a @Composable function span', () => {
    expect(leadingAnnotations('@Composable\nfun ForYouScreen(state: X) {}')).toEqual(['Composable']);
  });
});

describe('parsePrimaryConstructor', () => {
  it('parses fields with per-field annotations, nullability and defaults', () => {
    const code = [
      '@Entity',
      'data class NewsResourceEntity(',
      '    @PrimaryKey val id: String,',
      '    val title: String,',
      '    @ColumnInfo(defaultValue = "") val headerImageUrl: String?,',
      '    val publishDate: Instant = Clock.System.now(),',
      ')',
    ].join('\n');
    const fields = parsePrimaryConstructor(code);
    expect(fields.map((f) => f.name)).toEqual(['id', 'title', 'headerImageUrl', 'publishDate']);
    expect(fields[0]).toMatchObject({ name: 'id', type: 'String', annotations: ['PrimaryKey'] });
    expect(fields[2]).toMatchObject({ name: 'headerImageUrl', type: 'String', nullable: true });
    expect(fields[3]).toMatchObject({ name: 'publishDate', type: 'Instant', hasDefault: true });
  });

  it('keeps generics intact and ignores non-property params', () => {
    const code = 'data class Wrap<T>(val data: List<Map<String, T>>, plainParam: Int)';
    const fields = parsePrimaryConstructor(code);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ name: 'data', type: 'List<Map<String, T>>' });
  });

  it('returns [] for a class with no primary constructor', () => {
    expect(parsePrimaryConstructor('class Service {\n  val x = 1\n}')).toEqual([]);
  });
});

describe('functionParts', () => {
  it('reads @Provides return type and param types', () => {
    const code = '@Provides\nfun providesTopicsDao(database: NiaDatabase): TopicDao = database.topicDao()';
    expect(functionParts(code)).toEqual({ paramTypes: ['NiaDatabase'], returnType: 'TopicDao' });
  });

  it('reads @Binds iface←impl (return type + first param)', () => {
    const code = '@Binds\nabstract fun bindRepo(impl: TopicRepositoryImpl): TopicRepository';
    const parts = functionParts(code);
    expect(parts.returnType).toBe('TopicRepository');
    expect(parts.paramTypes[0]).toBe('TopicRepositoryImpl');
  });
});

describe('hasInjectConstructor + superTypes', () => {
  it('detects @Inject constructor', () => {
    expect(hasInjectConstructor('class VM @Inject constructor(private val repo: R)')).toBe(true);
    expect(hasInjectConstructor('class VM constructor()')).toBe(false);
  });

  it('reads supertypes after the primary constructor', () => {
    const code = 'class ForYouViewModel @Inject constructor(r: Repo) : ViewModel(), Loggable {';
    expect(superTypes(code)).toEqual(['ViewModel', 'Loggable']);
  });

  it('reads a NavKey supertype on a serializable object', () => {
    expect(superTypes('@Serializable\nobject ForYouNavKey : NavKey')).toEqual(['NavKey']);
  });
});

describe('annotationArg + sanitizeKotlin', () => {
  it('extracts a named annotation argument value', () => {
    expect(annotationArg('@Entity(tableName = "topics")\ndata class T', 'Entity', 'tableName')).toBe('topics');
  });

  it('sanitize blanks string contents but preserves length and newlines', () => {
    const src = 'val s = "class fun"\nclass Real';
    const out = sanitizeKotlin(src);
    expect(out.length).toBe(src.length);
    expect(out.split('\n')).toHaveLength(2);
    expect(out).not.toContain('class fun'); // literal blanked
    expect(out).toContain('class Real'); // real declaration kept
  });
});

describe('topLevelConstants (U7)', () => {
  it('recovers string/number const val values sliced from the ORIGINAL code', () => {
    const code = [
      'object ApiConfig {',
      '    const val BASE_URL = "https://api.example.com/v1"',
      '    const val PAGE_SIZE = 20',
      '    const val TAG = "// not a comment, class not a keyword"',
      '}',
    ].join('\n');
    const consts = topLevelConstants(code);
    expect(consts).toEqual([
      { name: 'BASE_URL', value: 'https://api.example.com/v1', valueKind: 'string' },
      { name: 'PAGE_SIZE', value: '20', valueKind: 'number' },
      { name: 'TAG', value: '// not a comment, class not a keyword', valueKind: 'string' },
    ]);
  });

  it('skips const vals whose value is an expression or reference', () => {
    const code = [
      'const val A = "x" + "y"',
      'const val B = OTHER',
      'const val C = "solo"',
    ].join('\n');
    expect(topLevelConstants(code).map((c) => c.name)).toEqual(['C']);
  });

  it('handles negative and typed number literals', () => {
    const code = 'const val OFFSET = -3\nconst val TIMEOUT = 5000L';
    expect(topLevelConstants(code)).toEqual([
      { name: 'OFFSET', value: '-3', valueKind: 'number' },
      { name: 'TIMEOUT', value: '5000L', valueKind: 'number' },
    ]);
  });
});

describe('enumEntries (U7)', () => {
  it('reads entries up to the first `;`, ignoring member functions', () => {
    const code = 'enum class SyncState {\n  IDLE, RUNNING, FAILED;\n  fun isDone() = this == FAILED\n}';
    expect(enumEntries(code)).toEqual(['IDLE', 'RUNNING', 'FAILED']);
  });

  it('handles entries with constructor args and a primary constructor', () => {
    const code = 'enum class Planet(val mass: Double) {\n  EARTH(5.9), MARS(6.4)\n}';
    expect(enumEntries(code)).toEqual(['EARTH', 'MARS']);
  });

  it('returns [] for a non-enum class', () => {
    expect(enumEntries('class Color { val red = 1 }')).toEqual([]);
  });
});

describe('annotationPositionalArg (U7)', () => {
  it('reads a Retrofit route path', () => {
    expect(annotationPositionalArg('@GET("/topics/{id}")\nsuspend fun get(): T', 'GET')).toBe('/topics/{id}');
  });

  it('reads a triple-quoted, multi-line SQL query with nested parens', () => {
    const code = [
      '@Query("""',
      '    SELECT * FROM news WHERE id IN (SELECT news_id FROM bookmarks)',
      '""")',
      'fun bookmarked(): List<News>',
    ].join('\n');
    expect(annotationPositionalArg(code, 'Query')?.trim()).toBe(
      'SELECT * FROM news WHERE id IN (SELECT news_id FROM bookmarks)'
    );
  });

  it('tolerates the `value = "…"` named form', () => {
    expect(annotationPositionalArg('@GET(value = "/x")\nfun f()', 'GET')).toBe('/x');
  });

  it('returns null for a non-string positional argument', () => {
    expect(annotationPositionalArg('@Header(CONTENT_TYPE)\nfun f()', 'Header')).toBeNull();
  });
});
