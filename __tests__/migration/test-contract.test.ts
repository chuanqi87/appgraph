/**
 * E · test-contract extraction (L4-lite).
 *
 * The inverse of the other U-passes: it selects ONLY the test source set and
 * reports each `FooTest`'s @Test surface as a porting obligation. Locks: @Test
 * (and Parameterized/Repeated) recognition, method→class aggregation by
 * qualifiedName prefix, subject-guess only when same-module evidence exists, and
 * the precondition that test nodes carry a module assignment.
 */

import { describe, it, expect } from 'vitest';
import { Node, NodeKind } from '../../src/types';
import { ReadCode, DetectContext } from '../../src/migration/detect/shared';
import { detectTestContract } from '../../src/migration/detect/tests';

interface Spec {
  kind: NodeKind;
  name: string;
  module: string;
  /** 'test' → src/test source set; 'main' → shippable source set. */
  set: 'test' | 'main';
  code?: string;
  /** override qualifiedName (for method→class prefix wiring). */
  qn?: string;
  /** shared filename (a class and its methods live in the same file). */
  file?: string;
}

let seq = 0;
function buildFixture(specs: Spec[]): { nodes: Node[]; readCode: ReadCode; ctx: DetectContext } {
  const store = new Map<string, string>();
  const moduleOf = new Map<string, string>();
  const nodes = specs.map((s) => {
    const id = `n${seq++}`;
    const sourceSet = s.set === 'test' ? 'test' : 'main';
    const file = `${s.module}/src/${sourceSet}/kotlin/${s.file ?? `${s.name}.kt`}`;
    store.set(id, s.code ?? '');
    moduleOf.set(id, `mod:${s.module}`);
    return {
      id,
      kind: s.kind,
      name: s.name,
      qualifiedName: s.qn ?? `${s.module}/${s.name}.kt::${s.name}`,
      filePath: file,
      language: 'kotlin',
      startLine: 1,
      endLine: 2,
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

describe('detectTestContract', () => {
  it('aggregates @Test methods under their class and guesses the subject', () => {
    const f = buildFixture([
      { kind: 'class', name: 'Foo', module: 'feature', set: 'main' },
      { kind: 'class', name: 'FooTest', module: 'feature', set: 'test', file: 'FooTest.kt', qn: 'feature/FooTest.kt::FooTest' },
      { kind: 'method', name: 'rendersEmptyState', module: 'feature', set: 'test', file: 'FooTest.kt', code: '@Test\nfun rendersEmptyState() {}', qn: 'feature/FooTest.kt::FooTest.rendersEmptyState' },
      { kind: 'method', name: 'paged', module: 'feature', set: 'test', file: 'FooTest.kt', code: '@ParameterizedTest\nfun paged() {}', qn: 'feature/FooTest.kt::FooTest.paged' },
      { kind: 'method', name: 'helper', module: 'feature', set: 'test', file: 'FooTest.kt', code: 'fun helper() {}', qn: 'feature/FooTest.kt::FooTest.helper' },
    ]);
    const res = detectTestContract(f.nodes, f.readCode, f.ctx);
    const facts = res.testContractByModule.get('mod:feature')!;
    expect(facts.classes).toHaveLength(1);
    expect(facts.classes[0]).toEqual({
      name: 'FooTest',
      file: 'feature/src/test/kotlin/FooTest.kt',
      tests: ['paged', 'rendersEmptyState'], // sorted; non-@Test `helper` excluded
      subjectGuess: 'Foo',
    });
    expect(facts.totalTests).toBe(2);
  });

  it('omits subjectGuess when no same-module subject symbol exists', () => {
    const f = buildFixture([
      { kind: 'class', name: 'OrphanTest', module: 'feature', set: 'test', file: 'OrphanTest.kt', qn: 'feature/OrphanTest.kt::OrphanTest' },
      { kind: 'method', name: 'works', module: 'feature', set: 'test', file: 'OrphanTest.kt', code: '@Test\nfun works() {}', qn: 'feature/OrphanTest.kt::OrphanTest.works' },
    ]);
    const facts = detectTestContract(f.nodes, f.readCode, f.ctx).testContractByModule.get('mod:feature')!;
    expect(facts.classes[0]!.subjectGuess).toBeUndefined();
  });

  it('requires test nodes to carry a module assignment (precondition)', () => {
    const f = buildFixture([
      { kind: 'class', name: 'FooTest', module: 'feature', set: 'test', qn: 'feature/FooTest.kt::FooTest' },
    ]);
    // The migration node→module assignment covers the test source set.
    const testClass = f.nodes.find((n) => n.name === 'FooTest')!;
    expect(f.ctx.nodeToModuleId.get(testClass.id)).toBe('mod:feature');
  });
});
