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
import {
  annotationArg,
  expressionBodyType,
  functionParts,
  hasInjectConstructor,
  leadingAnnotations,
  parsePrimaryConstructor,
  superTypes,
} from './kotlin-source';
import { DetectContext, isShippableJvmNode, ReadCode } from './shared';

/** DI assembly facts for one ArchModule (attached to its attrs by the orchestrator). */
export interface DiFacts {
  /** The source-side DI framework fingerprinted from imports (Hilt/Dagger/Koin/
   *  Metro/Anvil), or `manual` when constructor injection is hand-wired. */
  framework?: string;
  /** @Module class/object names in this module (+ @ContributesTo module facades). */
  modules: string[];
  /** Types produced via @Provides. */
  provides: string[];
  /**
   * Interface←impl bindings. `via` records the mechanism (`@Binds` or an
   * Anvil/Metro `@Contributes*`); `multibinding` marks a set/map contribution
   * (`@ContributesMultibinding`/`@ContributesIntoSet`/`@ContributesIntoMap`).
   */
  binds: Array<{ iface: string; impl: string; via?: string; multibinding?: boolean }>;
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
  const framework = detectDiFramework(nodes);
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
        f.binds.push({ iface: parts.returnType, impl: parts.paramTypes[0], via: '@Binds' });
        providerCount++;
        wire(edgeById, moduleId, parts.returnType, typeToModule, 'binds');
        wire(edgeById, moduleId, parts.paramTypes[0], typeToModule, 'binds');
      } else {
        // @Provides: prefer the explicit return type, else the type constructed in
        // an expression body (`fun x() = SomeImpl(...)`) — which functionParts
        // leaves null, so the provider was silently dropped before P3.2a.
        const provided = parts.returnType ?? (anno.includes('Provides') ? expressionBodyType(code) : null);
        if (provided) {
          pushUnique(f.provides, provided);
          providerCount++;
          wire(edgeById, moduleId, provided, typeToModule, 'provides');
        }
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

    // Auto-contributed bindings (Anvil/Metro): `@ContributesBinding` on an impl
    // class is a `iface ← impl` binding; the multibinding variants mark a set/map
    // contribution. Independent of the @Inject block above — an impl class is
    // usually both an injection point AND a contributed binding.
    if (node.kind === 'class') {
      const bind = contributedBinding(code, node.name, anno);
      if (bind) {
        factsFor(moduleId).binds.push(bind);
        providerCount++;
        wire(edgeById, moduleId, bind.iface, typeToModule, 'contributes');
        wire(edgeById, moduleId, bind.impl, typeToModule, 'contributes');
      }
      // `@ContributesTo(Scope::class)` contributes a module/component facade to a
      // scope — record the type so it reads as a DI module of this ArchModule.
      if (anno.includes('ContributesTo')) pushUnique(factsFor(moduleId).modules, node.name);
    }
  }

  // Stamp the fingerprinted framework onto every module that carries DI facts,
  // then sort each module's fact lists for determinism.
  for (const [moduleId, f] of facts) {
    f.framework = framework;
    facts.set(moduleId, sortFacts(f));
  }

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
    ...(f.framework ? { framework: f.framework } : {}),
    modules: [...new Set(f.modules)].sort(),
    provides: [...f.provides].sort(),
    binds: dedupBinds(f.binds).sort(
      (a, b) =>
        a.iface.localeCompare(b.iface) ||
        a.impl.localeCompare(b.impl) ||
        (a.via ?? '').localeCompare(b.via ?? '')
    ),
    injectionPoints: [...f.injectionPoints]
      .map((p) => ({ name: p.name, injects: [...p.injects].sort() }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    scopes: [...f.scopes].sort(),
  };
}

/** Dedup bindings by (iface, impl, via) — the same binding can surface twice. */
function dedupBinds(binds: DiFacts['binds']): DiFacts['binds'] {
  const seen = new Map<string, DiFacts['binds'][number]>();
  for (const b of binds) {
    const key = `${b.iface}\0${b.impl}\0${b.via ?? ''}`;
    if (!seen.has(key)) seen.set(key, b);
  }
  return [...seen.values()];
}

/**
 * The source-side DI framework, fingerprinted from import FQNs (the strongest,
 * most deterministic signal). Precedence resolves the mixed-import case (e.g. a
 * codebase migrating dagger→metro keeps stray `dagger.*` imports): the more
 * specific/active framework wins. `manual` = constructor injection with no
 * framework (only `javax.inject`/`jakarta.inject`, or none at all).
 */
export function detectDiFramework(nodes: Node[]): string {
  let hilt = false;
  let metro = false;
  let anvil = false;
  let koin = false;
  let dagger = false;
  for (const n of nodes) {
    if (n.kind !== 'import') continue;
    const fq = n.name;
    if (fq.startsWith('dagger.hilt')) hilt = true;
    else if (fq.startsWith('dev.zacsweers.metro')) metro = true;
    else if (fq.startsWith('com.squareup.anvil')) anvil = true;
    else if (fq.startsWith('org.koin')) koin = true;
    else if (fq.startsWith('dagger')) dagger = true;
  }
  if (hilt) return 'Hilt';
  if (metro) return 'Metro';
  if (anvil) return 'Anvil';
  if (koin) return 'Koin';
  if (dagger) return 'Dagger';
  return 'manual';
}

const CONTRIBUTES_MULTIBINDING = ['ContributesMultibinding', 'ContributesIntoSet', 'ContributesIntoMap'];

/**
 * The binding an Anvil/Metro `@Contributes*` annotation declares on an impl
 * class, or null if the class carries none. The interface is read from the
 * annotation's `boundType`/`binding` argument when present, else falls back to
 * the class's first declared supertype (the interface it implements).
 */
function contributedBinding(
  code: string,
  className: string,
  anno: string[]
): DiFacts['binds'][number] | null {
  const isBinding = anno.includes('ContributesBinding');
  const multiAnno = anno.find((a) => CONTRIBUTES_MULTIBINDING.includes(a));
  if (!isBinding && !multiAnno) return null;
  const via = isBinding ? 'ContributesBinding' : multiAnno!;
  const iface = contributedIface(code, via) ?? superTypes(code)[0] ?? null;
  if (!iface) return null;
  return {
    iface: baseTypeName(iface),
    impl: className,
    via: `@${via}`,
    ...(isBinding ? {} : { multibinding: true }),
  };
}

/** The bound interface named in a `@Contributes*` argument, or null. */
function contributedIface(code: string, annotation: string): string | null {
  const boundType = annotationArg(code, annotation, 'boundType');
  if (boundType) return stripClassRef(boundType);
  // Metro's `binding = binding<Iface>()` form.
  const binding = annotationArg(code, annotation, 'binding');
  if (binding) {
    const m = /<\s*([A-Za-z_][\w.]*)/.exec(binding);
    if (m) return m[1]!;
  }
  return null;
}

/** `Iface::class` / `Iface::class.java` → `Iface`. */
function stripClassRef(v: string): string {
  return v.replace(/::class(\s*\.\s*java)?\s*$/, '').trim();
}
