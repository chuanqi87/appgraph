/**
 * ArkTS builtin-method guard (`name-matcher.ts`).
 *
 * Every HarmonyOS project ships a router singleton with static
 * `push`/`pop`/`replace`. Bare-name matching therefore used to bind every array
 * mutation in the app to it — 63 bogus cross-module edges in one template —
 * which then fabricated module dependencies and skewed feature clustering.
 *
 * These tests drive the real indexer, because the guard only matters in
 * combination with the rest of the resolution chain: a genuine
 * `RouterModule.push(...)` must still resolve through the class-name strategy.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CodeGraph } from '../src/index';
import { CodeSymbolGraph } from '../src/appgraph/graph-reader';
import type { Node } from '../src/types';

let root: string;
let nodes: Node[];
let byId: Map<string, Node>;
let callEdges: Array<{ source: string; target: string }>;

function write(rel: string, content: string): void {
  const abs = join(root, ...rel.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

/** Names of everything the given function resolves a `calls` edge to. */
function calleesOf(fnName: string): string[] {
  const fn = nodes.find((n) => n.name === fnName && (n.kind === 'method' || n.kind === 'function'));
  if (!fn) return [];
  return callEdges
    .filter((e) => e.source === fn.id)
    .map((e) => byId.get(e.target))
    .filter((n): n is Node => Boolean(n))
    .map((n) => `${n.kind}:${n.name}`)
    .sort();
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'arkts-builtin-guard-'));

  // The router singleton every HarmonyOS project defines.
  write(
    'src/main/ets/RouterModule.ets',
    `export class RouterModule {
  static stack: NavPathStack = new NavPathStack();
  public static push(url: string) { RouterModule.stack.pushPathByName(url); }
  public static pop() { RouterModule.stack.pop(); }
  public static replace(url: string) { RouterModule.stack.replacePathByName(url); }
}`
  );

  // A free function that legitimately shares a builtin name.
  write('src/main/ets/Helpers.ets', `export function find(list: string[]): string { return list[0]; }`);

  write(
    'src/main/ets/Cart.ets',
    `import { RouterModule } from './RouterModule';
import { find } from './Helpers';

export class Cart {
  private items: string[] = [];
  private labels: string[] = [];

  // Plain collection operations — must NOT bind to RouterModule.
  addItem(name: string) {
    this.items.push(name);
    this.labels.push(name.replace('a', 'b'));
  }

  dropItem() {
    this.items.pop();
  }

  // A genuine static call — must STILL resolve.
  goCheckout() {
    RouterModule.push('CheckoutPage');
  }

  // A free function with a builtin name — allowed.
  first(): string {
    return find(this.items);
  }
}`
  );

  const cg = await CodeGraph.init(root, { index: true });
  cg.close();

  const reader = CodeSymbolGraph.open(root);
  try {
    nodes = reader.getAllNodes();
    byId = new Map(nodes.map((n) => [n.id, n]));
    callEdges = reader.getAllEdges().filter((e) => e.kind === 'calls');
  } finally {
    reader.close();
  }
}, 120_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('collection builtins do not bind to the router singleton', () => {
  it('`this.items.push(x)` produces no call to RouterModule.push', () => {
    expect(calleesOf('addItem')).not.toContain('method:push');
  });

  it('`str.replace(...)` produces no call to RouterModule.replace', () => {
    expect(calleesOf('addItem')).not.toContain('method:replace');
  });

  it('`this.items.pop()` produces no call to RouterModule.pop', () => {
    expect(calleesOf('dropItem')).not.toContain('method:pop');
  });

  it('never resolves a builtin name to a non-callable symbol', () => {
    // Admitting constants/properties/enum members just swaps one family of
    // bogus `calls` edges for another.
    const nonCallable = new Set(['constant', 'property', 'enum_member', 'variable']);
    for (const name of ['addItem', 'dropItem']) {
      for (const callee of calleesOf(name)) {
        expect(nonCallable.has(callee.split(':')[0]!)).toBe(false);
      }
    }
  });
});

describe('genuine calls are unaffected', () => {
  it('`RouterModule.push(...)` still resolves — the receiver names the class', () => {
    expect(calleesOf('goCheckout')).toContain('method:push');
  });

  it('a free function sharing a builtin name still resolves', () => {
    expect(calleesOf('first')).toContain('function:find');
  });
});
