/**
 * P · unit acceptance contract.
 *
 * Locks the contract's load-bearing invariants: the check-id formula (content
 * identity), PACK INVARIANCE (re-packing units moves a check between files but
 * never changes its id), split-unit assignment (file anchor → owning slice,
 * module-level → completion gate), byte-determinism, and the contract-driven
 * acceptance section in the brief.
 */

import { describe, it, expect } from 'vitest';
import { emptyMigrationGraph, mergeInto, MigrationGraph, MigrationUnit } from '../../src/migration/types';
import { AppNode, makeNodeId } from '../../src/appgraph/schema';
import { Node } from '../../src/types';
import { buildAssemblyInput } from '../../src/migration/plan';
import { buildUnitContracts, checkId, ContractUnitInput } from '../../src/migration/plan/contract';
import { renderUnitBrief } from '../../src/migration/plan/brief';
import { canonicalJson } from '../../src/appgraph/serialize';
import { CodeSymbolGraph } from '../../src/appgraph/graph-reader';

const NET_ID = makeNodeId('android', 'ArchModule', 'module:corenetwork');
const F_SERVICE = 'core/network/src/main/kotlin/ApiService.kt';
const F_MODEL = 'core/network/src/main/kotlin/NetworkModel.kt';
const F_CONFIG = 'core/network/src/main/kotlin/Config.kt';

function graphWithConstants(): MigrationGraph {
  const graph = emptyMigrationGraph({ platform: 'android', app: { name: 'toy', packageName: 'com.toy' } });
  const net: AppNode = {
    id: NET_ID,
    kind: 'ArchModule',
    matchKey: 'module:corenetwork',
    name: ':core:network',
    platform: 'android',
    provenance: 'lifted',
    fidelity: 'source-project',
    confidence: 1,
    attrs: {
      dir: 'core/network',
      // U7 constants live on the module node — anchored to a file no slice owns.
      constants: {
        literals: [{ name: 'BASE_URL', value: 'https://api.example.com', kind: 'url', file: F_CONFIG }],
        routes: [],
        queries: [],
        enums: [],
      },
    },
  };
  mergeInto(graph, { nodes: [net], edges: [] });
  return graph;
}

function reader(): CodeSymbolGraph {
  const nodes: Node[] = [
    codeNode('n1', 'class', 'ApiService', F_SERVICE),
    codeNode('n2', 'class', 'NetworkModel', F_MODEL),
  ];
  return { getAllNodes: () => nodes } as unknown as CodeSymbolGraph;
}

function codeNode(id: string, kind: Node['kind'], name: string, filePath: string): Node {
  return {
    id, kind, name,
    qualifiedName: `${filePath}::${name}`,
    filePath, language: 'kotlin',
    startLine: 1, endLine: 2, startColumn: 0, endColumn: 0,
    visibility: 'public',
  } as Node;
}

const fullUnit: ContractUnitInput = { id: 'u-full', order: 0, label: ':core:network', moduleIds: [NET_ID] };
const sliceA: ContractUnitInput = { id: 'u-a', order: 0, label: ':core:network#a', moduleIds: [NET_ID], files: [F_SERVICE] };
const sliceB: ContractUnitInput = { id: 'u-b', order: 1, label: ':core:network#b', moduleIds: [NET_ID], files: [F_MODEL] };

describe('checkId', () => {
  it('pins the content-derived formula', () => {
    expect(checkId('interface', 'mod1', 'com.x.Foo')).toBe('e3d563ad2939414d');
  });

  it('changes only when kind/module/subject change', () => {
    const base = checkId('interface', 'mod1', 'com.x.Foo');
    expect(checkId('screen', 'mod1', 'com.x.Foo')).not.toBe(base);
    expect(checkId('interface', 'mod2', 'com.x.Foo')).not.toBe(base);
    expect(checkId('interface', 'mod1', 'com.x.Bar')).not.toBe(base);
  });
});

describe('buildUnitContracts', () => {
  it('generates interface + constant checks from module facts', () => {
    const input = buildAssemblyInput(graphWithConstants(), reader());
    const contract = buildUnitContracts([fullUnit], input).get('u-full')!;
    const kinds = contract.checks.map((c) => c.kind).sort();
    expect(kinds).toContain('interface');
    expect(kinds).toContain('constant');
    const iface = contract.checks.filter((c) => c.kind === 'interface').map((c) => c.subject).sort();
    expect(iface).toEqual([`${F_SERVICE}::ApiService`, `${F_MODEL}::NetworkModel`]);
    const url = contract.checks.find((c) => c.kind === 'constant')!;
    expect(url.subject).toBe('BASE_URL=https://api.example.com');
    expect(url.params).toEqual({ value: 'https://api.example.com' });
  });

  it('is PACK-INVARIANT: the check-id set is identical across unit layouts', () => {
    const input = buildAssemblyInput(graphWithConstants(), reader());
    const full = buildUnitContracts([fullUnit], input);
    const split = buildUnitContracts([sliceA, sliceB], input);

    const idsFull = [...full.get('u-full')!.checks.map((c) => c.id)].sort();
    const idsSplit = [...split.get('u-a')!.checks, ...split.get('u-b')!.checks].map((c) => c.id).sort();
    expect(idsSplit).toEqual(idsFull);
  });

  it('assigns file-anchored checks to their slice, module-level to the max-order slice', () => {
    const input = buildAssemblyInput(graphWithConstants(), reader());
    const split = buildUnitContracts([sliceA, sliceB], input);
    const inA = split.get('u-a')!.checks.map((c) => c.subject);
    const inB = split.get('u-b')!.checks.map((c) => c.subject);
    // ApiService interface → slice A (owns ApiService.kt).
    expect(inA).toContain(`${F_SERVICE}::ApiService`);
    // NetworkModel interface → slice B.
    expect(inB).toContain(`${F_MODEL}::NetworkModel`);
    // The constant is anchored to Config.kt, owned by no slice → max-order slice (B).
    expect(inB).toContain('BASE_URL=https://api.example.com');
    expect(inA).not.toContain('BASE_URL=https://api.example.com');
  });

  it('is byte-identical across two runs', () => {
    const input = buildAssemblyInput(graphWithConstants(), reader());
    const a = canonicalJson([...buildUnitContracts([sliceA, sliceB], input)]);
    const b = canonicalJson([...buildUnitContracts([sliceA, sliceB], input)]);
    expect(a).toBe(b);
  });
});

describe('brief acceptance section is contract-driven', () => {
  it('renders the contract checks when a contract is supplied', () => {
    const input = buildAssemblyInput(graphWithConstants(), reader());
    const contract = buildUnitContracts([fullUnit], input).get('u-full')!;
    const unit: MigrationUnit = { id: 'u-full', moduleIds: [NET_ID], label: ':core:network', order: 0, cyclic: false };
    const md = renderUnitBrief(unit, [], 1, contract);
    expect(md).toContain('## 验收契约(机器可核对)');
    expect(md).toContain('公开成员'); // interface aggregation line
    expect(md).toContain('常量 BASE_URL'); // constant check listed
    expect(md).toContain('--unit ":core:network"');
  });

  it('falls back to the checklist when no contract is supplied', () => {
    const unit: MigrationUnit = { id: 'u', moduleIds: ['m'], label: ':m', order: 0, cyclic: false };
    const md = renderUnitBrief(unit, [], 1);
    expect(md).toContain('## 验收清单');
  });
});
