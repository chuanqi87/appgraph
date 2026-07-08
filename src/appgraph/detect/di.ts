/**
 * U4 · dependency-injection object graph.
 *
 * HarmonyOS has no Hilt/Dagger, so a faithful migration must UNDERSTAND the
 * assembly graph to regenerate it as manual constructor injection / singleton
 * providers. Phase-2 only had a boolean `di.inject` capability flag — enough to
 * know a module uses DI, not enough to reassemble it.
 *
 * This recovers the Hilt/Dagger wiring: `@Module` + `@Provides`/`@Binds`
 * producers, and `@Inject constructor` / `@HiltViewModel` consumers, plus a
 * cross-module `depends_on` edge (tagged `diKind`) whenever a produced type is
 * declared in a different ArchModule. The per-module facts feed the LLM context.
 */

import { AppEdge, CoverageWarning, makeEdgeId } from '../schema';
import { Node } from '../../types';
import { functionParts, hasInjectConstructor, leadingAnnotations, parsePrimaryConstructor } from './kotlin-source';
import { DetectContext, isShippableJvmNode, ReadCode } from './shared';

/** DI assembly facts for one ArchModule (attached to its attrs by the orchestrator). */
export interface DiFacts {
  /** @Module class/object names in this module. */
  modules: string[];
  /** Types produced via @Provides. */
  provides: string[];
  /** Interface←impl bindings via @Binds. */
  binds: Array<{ iface: string; impl: string }>;
  /** Injection points: a consumer and the types it is constructed with. */
  injectionPoints: Array<{ name: string; injects: string[] }>;
  /** Hilt component scopes seen (@InstallIn). */
  scopes: string[];
}

export interface DiResult {
  diByModule: Map<string, DiFacts>;
  diEdges: AppEdge[];
  warnings: CoverageWarning[];
  stats: { moduleCount: number; providerCount: number; injectionPoints: number; wiredEdges: number };
}

const DI_KINDS = new Set(['class', 'function', 'method']);

/** Detect the DI object graph. */
export function detectDi(nodes: Node[], readCode: ReadCode, ctx: DetectContext): DiResult {
  const typeToModule = buildTypeIndex(nodes, ctx);
  const facts = new Map<string, DiFacts>();
  const edgeById = new Map<string, AppEdge>();
  const warnings: CoverageWarning[] = [];
  let providerCount = 0;
  let injectionPoints = 0;

  const factsFor = (moduleId: string): DiFacts => {
    let f = facts.get(moduleId);
    if (!f) {
      f = { modules: [], provides: [], binds: [], injectionPoints: [], scopes: [] };
      facts.set(moduleId, f);
    }
    return f;
  };

  const sorted = [...nodes]
    .filter((n) => isShippableJvmNode(n) && DI_KINDS.has(n.kind))
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const node of sorted) {
    const moduleId = ctx.nodeToModuleId.get(node.id);
    if (!moduleId) continue;
    const code = readCode(node);
    if (code === null) continue;
    const anno = leadingAnnotations(code);

    // Producers.
    if (node.kind === 'class' && anno.includes('Module')) {
      const f = factsFor(moduleId);
      pushUnique(f.modules, node.name);
      const scope = installInScope(code);
      if (scope) pushUnique(f.scopes, scope);
      continue;
    }
    if ((node.kind === 'method' || node.kind === 'function') && (anno.includes('Provides') || anno.includes('Binds'))) {
      const parts = functionParts(code);
      const f = factsFor(moduleId);
      if (anno.includes('Binds') && parts.returnType && parts.paramTypes[0]) {
        f.binds.push({ iface: parts.returnType, impl: parts.paramTypes[0] });
        providerCount++;
        wire(edgeById, moduleId, parts.returnType, typeToModule, 'binds');
        wire(edgeById, moduleId, parts.paramTypes[0], typeToModule, 'binds');
      } else if (parts.returnType) {
        pushUnique(f.provides, parts.returnType);
        providerCount++;
        wire(edgeById, moduleId, parts.returnType, typeToModule, 'provides');
      }
      continue;
    }

    // Consumers.
    if (node.kind === 'class' && (anno.includes('HiltViewModel') || hasInjectConstructor(code))) {
      const injects = parsePrimaryConstructor(code)
        .map((field) => baseTypeName(field.type))
        .filter((t) => t.length > 0);
      const f = factsFor(moduleId);
      f.injectionPoints.push({ name: node.name, injects });
      injectionPoints++;
      for (const t of injects) wire(edgeById, moduleId, t, typeToModule, 'injects');
    }
  }

  // Sort each module's fact lists for determinism.
  for (const [moduleId, f] of facts) facts.set(moduleId, sortFacts(f));

  return {
    diByModule: facts,
    diEdges: [...edgeById.values()].sort((a, b) => a.id.localeCompare(b.id)),
    warnings,
    stats: {
      moduleCount: facts.size,
      providerCount,
      injectionPoints,
      wiredEdges: edgeById.size,
    },
  };
}

/** Emit a cross-module DI `depends_on` when `type` is declared in another module. */
function wire(
  edgeById: Map<string, AppEdge>,
  fromModuleId: string,
  type: string,
  typeToModule: Map<string, string>,
  diKind: string
): void {
  const toModuleId = typeToModule.get(type);
  if (!toModuleId || toModuleId === fromModuleId) return;
  const id = makeEdgeId('depends_on', fromModuleId, toModuleId);
  const existing = edgeById.get(id);
  if (existing) {
    const kinds = new Set([...(asArray(existing.attrs?.diKind)), diKind]);
    existing.attrs = { ...existing.attrs, diKind: [...kinds].sort() };
    return;
  }
  edgeById.set(id, {
    id,
    kind: 'depends_on',
    from: fromModuleId,
    to: toModuleId,
    provenance: 'source-static',
    confidence: 0.6,
    attrs: { scope: 'di', diKind: [diKind] },
  });
}

/** Map every declared type name (class/interface/object) to its ArchModule id. */
function buildTypeIndex(nodes: Node[], ctx: DetectContext): Map<string, string> {
  const idx = new Map<string, string>();
  const decl = [...nodes]
    .filter((n) => (n.kind === 'class' || n.kind === 'interface') && isShippableJvmNode(n))
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const n of decl) {
    const moduleId = ctx.nodeToModuleId.get(n.id);
    if (moduleId && !idx.has(n.name)) idx.set(n.name, moduleId);
  }
  return idx;
}

/** `@InstallIn(SingletonComponent::class)` → `SingletonComponent`. */
function installInScope(code: string): string | null {
  const m = /@InstallIn\s*\(\s*([A-Za-z_]\w*)/.exec(code);
  return m ? m[1]! : null;
}

function baseTypeName(type: string): string {
  let t = type.trim();
  const lt = t.indexOf('<');
  if (lt !== -1) t = t.slice(0, lt);
  const dot = t.lastIndexOf('.');
  return (dot !== -1 ? t.slice(dot + 1) : t).trim();
}

function pushUnique(arr: string[], value: string): void {
  if (!arr.includes(value)) arr.push(value);
}

function asArray(v: unknown): string[] {
  return Array.isArray(v) ? (v as string[]) : [];
}

function sortFacts(f: DiFacts): DiFacts {
  return {
    modules: [...f.modules].sort(),
    provides: [...f.provides].sort(),
    binds: [...f.binds].sort((a, b) => a.iface.localeCompare(b.iface) || a.impl.localeCompare(b.impl)),
    injectionPoints: [...f.injectionPoints]
      .map((p) => ({ name: p.name, injects: [...p.injects].sort() }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    scopes: [...f.scopes].sort(),
  };
}
