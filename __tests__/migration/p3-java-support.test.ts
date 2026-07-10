/**
 * P3.2a · widen the extractor to the Java old-style stack (AntennaPod / NewPipe).
 *
 * codegraph fills `Node.decorators` for NEITHER language (verified: 0 of 793
 * `java`/`class` nodes in AntennaPod carry decorators), so Java facts are
 * recovered from the source span just like Kotlin — but Java uses
 * `extends`/`implements` + `static final` where Kotlin uses `: Base` +
 * `const val`, and Anvil/Metro auto-bindings + non-Hilt DI frameworks were
 * unrecognized. These lock the four widenings:
 *   1. Java custom-View supertypes  2. Java `static final` constants
 *   3. DI framework fingerprint      4. @Provides expr-body + @Contributes*
 */

import { describe, it, expect } from 'vitest';
import { Node, NodeKind } from '../../src/types';
import { ReadCode, DetectContext } from '../../src/appgraph/detect/shared';
import { javaSuperTypes, javaStaticFinalConstants } from '../../src/appgraph/detect/java-source';
import { expressionBodyType } from '../../src/appgraph/detect/kotlin-source';
import { isAndroidViewSuper } from '../../src/appgraph/detect/roles';
import { detectConstants } from '../../src/appgraph/detect/constants';
import { detectDi, detectDiFramework } from '../../src/appgraph/detect/di';

interface Spec {
  kind: NodeKind;
  name: string;
  module: string;
  code: string;
  lang?: 'kotlin' | 'java';
  file?: string;
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
    const filePath = s.file ?? `${s.module}/src/main/${lang}/${s.name}.${ext}`;
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

// ── 1 · Java custom-View supertypes ────────────────────────────────────────
describe('P3.2a·1 · javaSuperTypes + isAndroidViewSuper (custom Views)', () => {
  const viewSuper = (code: string): string | undefined => javaSuperTypes(code).find(isAndroidViewSuper);

  it('reads the extends base of a Java View subclass', () => {
    expect(viewSuper('public class TimeRangeView extends View {')).toBe('View');
    expect(viewSuper('public class PlayButton extends AppCompatImageButton {')).toBe('AppCompatImageButton');
    expect(viewSuper('class EpisodeItemListRecyclerView extends RecyclerView {')).toBe('RecyclerView');
  });

  it('parses extends + implements, generics stripped, ignoring non-View interfaces', () => {
    expect(javaSuperTypes('class EqualizerBar extends LinearLayout implements View.OnClickListener {')).toEqual([
      'LinearLayout',
      'OnClickListener',
    ]);
    expect(viewSuper('class Chart extends AppCompatImageView<Data> implements Renderable {')).toBe(
      'AppCompatImageView'
    );
  });

  it('does not mistake a bounded type parameter for a supertype', () => {
    // `<T extends View>` is a bound, not the class supertype — the real base is Bar.
    expect(javaSuperTypes('class Holder<T extends View> extends Bar<T> implements Listener {')).toEqual([
      'Bar',
      'Listener',
    ]);
  });

  it('returns [] for a plain class and a fully-qualified inner base', () => {
    expect(javaSuperTypes('public class Plain { }')).toEqual([]);
    // `ActivityResultContracts.OpenDocumentTree` → base name `OpenDocumentTree` (not a View).
    expect(viewSuper('static class AddLocalFolder extends ActivityResultContracts.OpenDocumentTree {')).toBeUndefined();
  });
});

// ── 2 · Java static final constants ────────────────────────────────────────
describe('P3.2a·2 · javaStaticFinalConstants', () => {
  it('recovers string + number static-final literals, values sliced from source', () => {
    const code = [
      'public class PodDBAdapter {',
      '    public static final String KEY_DOWNLOAD_URL = "download_url";',
      '    public static final int VERSION = 3110000;',
      '    private static final int IN_OPERATOR_MAXIMUM = 800;',
      '    private String instanceField = "not_static";',
      '}',
    ].join('\n');
    expect(javaStaticFinalConstants(code)).toEqual([
      { name: 'KEY_DOWNLOAD_URL', value: 'download_url', valueKind: 'string' },
      { name: 'VERSION', value: '3110000', valueKind: 'number' },
      { name: 'IN_OPERATOR_MAXIMUM', value: '800', valueKind: 'number' },
    ]);
  });

  it('handles a multi-line initializer and skips arrays/expressions/method calls', () => {
    const code = [
      'class C {',
      '    static final String WRAPPED =',
      '        "line_wrapped_value";',
      '    static final String[] NAMES = { "a", "b" };', // array → skipped
      '    static final int COMPUTED = other() + 1;',     // expression → skipped
      '}',
    ].join('\n');
    expect(javaStaticFinalConstants(code)).toEqual([
      { name: 'WRAPPED', value: 'line_wrapped_value', valueKind: 'string' },
    ]);
  });

  it('is not fooled by `static final` text inside a string/comment', () => {
    const code = 'class C {\n  static final String NOTE = "static final String DECOY = 1";\n}';
    expect(javaStaticFinalConstants(code)).toEqual([
      { name: 'NOTE', value: 'static final String DECOY = 1', valueKind: 'string' },
    ]);
  });
});

describe('P3.2a·2 · detectConstants over Java static final', () => {
  it('feeds Java constants into the same literals structure + noise rules + url tag', () => {
    const f = buildFixture([
      {
        kind: 'constant',
        name: 'KEY_TITLE',
        module: 'storage',
        lang: 'java',
        code: 'public static final String KEY_TITLE = "title";',
      },
      {
        kind: 'constant',
        name: 'BASE_URL',
        module: 'storage',
        lang: 'java',
        code: 'public static final String BASE_URL = "https://api.example.com/v1";',
      },
      {
        kind: 'constant',
        name: 'KEY_ID',
        module: 'storage',
        lang: 'java',
        code: 'public static final String KEY_ID = "id";', // < 4 chars → dropped by noise rule
      },
    ]);
    const lits = detectConstants(f.nodes, f.readCode, f.ctx).constantsByModule.get('mod:storage')!.literals;
    expect(lits).toEqual([
      { name: 'BASE_URL', value: 'https://api.example.com/v1', kind: 'url', file: 'storage/src/main/java/BASE_URL.java' },
      { name: 'KEY_TITLE', value: 'title', kind: 'string', file: 'storage/src/main/java/KEY_TITLE.java' },
    ]);
  });
});

// ── 3 · DI framework fingerprint ───────────────────────────────────────────
describe('P3.2a·3 · detectDiFramework', () => {
  const imp = (fq: string): Node =>
    ({ id: `i${seq++}`, kind: 'import', name: fq, qualifiedName: fq, filePath: 'x.kt', language: 'kotlin', startLine: 1, endLine: 1, startColumn: 0, endColumn: 0, updatedAt: 0 } as Node);

  it('maps each framework from its import namespace', () => {
    expect(detectDiFramework([imp('dagger.hilt.android.HiltAndroidApp')])).toBe('Hilt');
    expect(detectDiFramework([imp('dev.zacsweers.metro.ContributesBinding')])).toBe('Metro');
    expect(detectDiFramework([imp('com.squareup.anvil.annotations.ContributesBinding')])).toBe('Anvil');
    expect(detectDiFramework([imp('org.koin.core.module.Module')])).toBe('Koin');
    expect(detectDiFramework([imp('dagger.Module'), imp('dagger.Provides')])).toBe('Dagger');
    expect(detectDiFramework([imp('javax.inject.Inject')])).toBe('manual');
    expect(detectDiFramework([])).toBe('manual');
  });

  it('prefers the active framework over stray dagger imports (dagger→metro migration)', () => {
    // CatchUp shape: metro is the active framework, dagger imports linger.
    expect(detectDiFramework([imp('dagger.Reusable'), imp('dev.zacsweers.metro.Provides')])).toBe('Metro');
    // Hilt wins over its own bare-dagger transitive imports.
    expect(detectDiFramework([imp('dagger.Binds'), imp('dagger.hilt.InstallIn')])).toBe('Hilt');
  });
});

// ── 4a · @Provides expression body ─────────────────────────────────────────
describe('P3.2a·4a · expressionBodyType (@Provides = SomeImpl(...))', () => {
  it('infers the constructed type when the return type is omitted', () => {
    expect(expressionBodyType('@Provides\nfun provideRepo(dep: Dep) = RepoImpl(dep)')).toBe('RepoImpl');
    expect(expressionBodyType('fun x() = com.example.Foo()')).toBe('Foo');
    expect(expressionBodyType('fun x() = Singleton')).toBe('Singleton'); // bare Capitalized reference
  });

  it('returns null rather than guess (lowercase factory call, block body, explicit type)', () => {
    expect(expressionBodyType('fun x() = retrofit.create(Api::class.java)')).toBeNull();
    expect(expressionBodyType('fun x(): Foo = Foo()')).toBeNull(); // explicit type → functionParts owns it
    expect(expressionBodyType('fun x() { return Foo() }')).toBeNull(); // block body
  });

  it('feeds the inferred provider type into detectDi', () => {
    const f = buildFixture([
      { kind: 'method', name: 'provideRepo', module: 'app', code: '@Provides\nfun provideRepo(db: Db) = RepoImpl(db)' },
    ]);
    const facts = detectDi(f.nodes, f.readCode, f.ctx).diByModule.get('mod:app')!;
    expect(facts.provides).toContain('RepoImpl');
  });
});

// ── 4b · @Contributes* auto-bindings ───────────────────────────────────────
describe('P3.2a·4b · detectDi @Contributes* bindings', () => {
  it('captures @ContributesBinding as iface←impl, ContributesIntoMap as multibinding, ContributesTo as module', () => {
    const f = buildFixture([
      {
        kind: 'class',
        name: 'LinkManager',
        module: 'app',
        code: '@ContributesBinding(AppScope::class)\n@Inject\nclass LinkManager(private val tab: CustomTab) : LinkManagerApi {',
      },
      {
        kind: 'class',
        name: 'CatchUpPreferencesImpl',
        module: 'app',
        code: '@ContributesBinding(AppScope::class, boundType = CatchUpPreferences::class)\nclass CatchUpPreferencesImpl(ctx: Context) : SomethingElse {',
      },
      {
        kind: 'class',
        name: 'HomeService',
        module: 'app',
        code: '@ContributesIntoMap(AppScope::class)\nclass HomeService : ServiceMeta {',
      },
      {
        kind: 'class',
        name: 'NetworkModule',
        module: 'app',
        code: '@ContributesTo(AppScope::class)\nclass NetworkModule {',
      },
      { kind: 'import', name: 'dev.zacsweers.metro.ContributesBinding', module: 'app', code: '' },
    ]);
    const facts = detectDi(f.nodes, f.readCode, f.ctx).diByModule.get('mod:app')!;
    expect(facts.framework).toBe('Metro');
    expect(facts.binds).toContainEqual({ iface: 'LinkManagerApi', impl: 'LinkManager', via: '@ContributesBinding' });
    // boundType arg overrides the (unrelated) first supertype.
    expect(facts.binds).toContainEqual({
      iface: 'CatchUpPreferences',
      impl: 'CatchUpPreferencesImpl',
      via: '@ContributesBinding',
    });
    expect(facts.binds).toContainEqual({
      iface: 'ServiceMeta',
      impl: 'HomeService',
      via: '@ContributesIntoMap',
      multibinding: true,
    });
    expect(facts.modules).toContain('NetworkModule');
  });

  it('two runs produce identical DI facts (determinism)', () => {
    const specs: Spec[] = [
      { kind: 'class', name: 'AImpl', module: 'm', code: '@ContributesBinding(S::class)\nclass AImpl : A {' },
      { kind: 'class', name: 'BImpl', module: 'm', code: '@ContributesBinding(S::class)\nclass BImpl : B {' },
      { kind: 'import', name: 'dev.zacsweers.metro.ContributesBinding', module: 'm', code: '' },
    ];
    seq = 0;
    const a = buildFixture(specs);
    const r1 = JSON.stringify([...detectDi(a.nodes, a.readCode, a.ctx).diByModule]);
    seq = 0;
    const b = buildFixture(specs);
    const r2 = JSON.stringify([...detectDi(b.nodes, b.readCode, b.ctx).diByModule]);
    expect(r1).toBe(r2);
  });
});
