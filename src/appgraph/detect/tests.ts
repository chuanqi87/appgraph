/**
 * E · test-contract extraction (L4-lite).
 *
 * appgraph does NOT run tests — but the source test suite is a behavioural
 * contract the migration must carry over: each `FooTest` names an obligation to
 * port an equivalent target test and self-certify it passes. This pass is the
 * INVERSE of every other U-pass: instead of excluding the test source set
 * (`isShippableJvmNode`), it selects ONLY it, and reports the @Test surface as a
 * porting checklist. It never asserts pass/fail — that stays the migrator's job.
 *
 * Pure + deterministic over its inputs (nodes + memoized source reader).
 */

import { Node } from '../../types';
import { leadingAnnotations } from './kotlin-source';
import { DetectContext, isTestPath, ReadCode } from './shared';

/** One source test class → the target-side porting obligation it represents. */
export interface TestClassFacts {
  name: string;
  file: string;
  /** @Test method names, sorted, capped. */
  tests: string[];
  /** Best-effort subject-under-test (`FooTest`→`Foo`), only when evidence exists. */
  subjectGuess?: string;
}

export interface TestContractFacts {
  classes: TestClassFacts[];
  totalTests: number;
}

export interface TestContractResult {
  testContractByModule: Map<string, TestContractFacts>;
  stats: { modulesWithTests: number; testClasses: number; totalTests: number };
}

const TEST_ANNOTATIONS = new Set(['Test', 'ParameterizedTest', 'RepeatedTest']);
const METHOD_KINDS = new Set(['method', 'function']);
const DECL_KINDS = new Set(['class', 'interface', 'enum', 'struct', 'function', 'object']);
const MAX_TESTS_PER_CLASS = 100;

/** True for a Kotlin/Java symbol under a test source set (the inverse filter). */
function isJvmTestNode(node: Node): boolean {
  return (node.language === 'kotlin' || node.language === 'java') && isTestPath(node.filePath);
}

/** Recover each module's test-porting contract from its test source set. */
export function detectTestContract(
  nodes: Node[],
  readCode: ReadCode,
  ctx: DetectContext
): TestContractResult {
  const sorted = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const nonTestNames = nonTestNamesByModule(sorted, ctx);

  // Test class nodes, grouped by file for method attribution.
  const classNodes = sorted.filter((n) => isJvmTestNode(n) && n.kind === 'class');
  const classesByFile = new Map<string, Node[]>();
  for (const c of classNodes) {
    const list = classesByFile.get(c.filePath) ?? [];
    list.push(c);
    classesByFile.set(c.filePath, list);
  }
  // Longest qualifiedName first so a nested class wins the prefix match.
  for (const list of classesByFile.values()) {
    list.sort((a, b) => b.qualifiedName.length - a.qualifiedName.length);
  }

  const testsByClassId = new Map<string, string[]>();
  for (const method of sorted) {
    if (!isJvmTestNode(method) || !METHOD_KINDS.has(method.kind)) continue;
    const code = readCode(method);
    if (code === null) continue;
    if (!leadingAnnotations(code).some((a) => TEST_ANNOTATIONS.has(a))) continue;
    const owner = attributeToClass(method, classesByFile.get(method.filePath) ?? []);
    if (!owner) continue;
    const list = testsByClassId.get(owner.id) ?? [];
    list.push(method.name);
    testsByClassId.set(owner.id, list);
  }

  const byModule = new Map<string, TestClassFacts[]>();
  for (const c of classNodes) {
    const tests = testsByClassId.get(c.id);
    if (!tests || tests.length === 0) continue;
    const moduleId = ctx.nodeToModuleId.get(c.id);
    if (!moduleId) continue;
    const facts: TestClassFacts = {
      name: c.name,
      file: c.filePath,
      tests: [...new Set(tests)].sort().slice(0, MAX_TESTS_PER_CLASS),
    };
    const subject = subjectGuess(c.name, nonTestNames.get(moduleId));
    if (subject) facts.subjectGuess = subject;
    const list = byModule.get(moduleId) ?? [];
    list.push(facts);
    byModule.set(moduleId, list);
  }

  const testContractByModule = new Map<string, TestContractFacts>();
  let testClasses = 0;
  let totalTests = 0;
  for (const [moduleId, classes] of byModule) {
    classes.sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file));
    const total = classes.reduce((n, c) => n + c.tests.length, 0);
    testContractByModule.set(moduleId, { classes, totalTests: total });
    testClasses += classes.length;
    totalTests += total;
  }

  return {
    testContractByModule,
    stats: { modulesWithTests: testContractByModule.size, testClasses, totalTests },
  };
}

/** The test class a method belongs to: prefix match, else the file's sole class. */
function attributeToClass(method: Node, candidates: Node[]): Node | null {
  const byPrefix = candidates.find((c) => method.qualifiedName.startsWith(c.qualifiedName));
  if (byPrefix) return byPrefix;
  return candidates.length === 1 ? candidates[0]! : null;
}

/** `FooTest`→`Foo`, only when a same-named non-test symbol exists in the module. */
function subjectGuess(className: string, names: Set<string> | undefined): string | undefined {
  if (!names) return undefined;
  if (className.endsWith('Test') && className.length > 4) {
    const subject = className.slice(0, -4);
    if (names.has(subject)) return subject;
  }
  return undefined;
}

/** module id → set of non-test declaration names (for subject-guess evidence). */
function nonTestNamesByModule(nodes: Node[], ctx: DetectContext): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const n of nodes) {
    if (isTestPath(n.filePath)) continue;
    if (!(n.language === 'kotlin' || n.language === 'java')) continue;
    if (!DECL_KINDS.has(n.kind)) continue;
    const moduleId = ctx.nodeToModuleId.get(n.id);
    if (!moduleId) continue;
    const set = out.get(moduleId) ?? new Set<string>();
    set.add(n.name);
    out.set(moduleId, set);
  }
  return out;
}
