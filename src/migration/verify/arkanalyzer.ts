/**
 * T1+T2 · symbol-level target-side reconstruction via ArkAnalyzer.
 *
 * Phase 1 recovered the generated HarmonyOS code with focused regex
 * (`parse-ets.ts`): capability *markers* by substring, `@Entry` pages by a page
 * scanner. That is coarse (a capability marker in a *comment* counts) and blind
 * to interface signatures and the call/view structure.
 *
 * ArkAnalyzer (OpenHarmony SIG, ICSE'25) is a Soot-style static analyzer that
 * builds a real symbol graph over ArkTS/ETS/TS — ArkFile/ArkClass/ArkMethod IR
 * plus @Component ViewTrees. This module drives it to reconstruct the target
 * AppGraph at the SYMBOL level:
 *   - target capabilities from real `@ohos.*`/`@kit.*` imports (precise to the
 *     import, not a comment substring),
 *   - Screen nodes from @Entry/@Component structs (ViewTree-backed), and
 *   - the module's exported interface (classes/methods + signatures), for the
 *     phase-2 interface-fidelity check.
 *
 * OPTIONAL + FALLBACK by design (mirrors `@anthropic-ai/sdk`): `arkanalyzer` is
 * required indirectly, and every failure path (dep missing, Scene build throws,
 * no analyzable files) returns `null` so the caller degrades to the phase-1
 * regex path and never blocks the pipeline. No OHOS SDK is required — type
 * inference degrades gracefully (validated in the T0 spike).
 */

import { AppNode, makeNodeId, screenMatchKey } from '../schema';
import { VERIFIABLE_SPECS } from './parse-ets';

/** ArkAnalyzer class categories observed in the T0 spike (no public enum export). */
const CATEGORY_CLASS = 0;
const CATEGORY_STRUCT = 1;
const CATEGORY_INTERFACE = 2;

export type ArkExportKind = 'class' | 'struct' | 'interface' | 'enum' | 'function';

/** One exported symbol recovered from the generated target module. */
export interface ArkExport {
  name: string;
  kind: ArkExportKind;
  signature: string;
  file: string;
  /** True for @Component/@Entry structs (ArkUI components / pages). */
  isComponent: boolean;
  /** Declared field/property names (for V2 entity schema fidelity), best-effort. */
  fields: string[];
}

export interface ArkTargetGraph {
  /** HarmonyOS Capability nodes, one per capability detected from real imports. */
  capabilityNodes: AppNode[];
  /** Screen nodes recovered from @Entry/@Component structs (ViewTree-backed). */
  screenNodes: AppNode[];
  /** Every exported symbol — the target's public surface (interface fidelity). */
  exports: ArkExport[];
  /** Structural-validity signal: did the Scene parse, and what did it yield. */
  structural: {
    buildOk: boolean;
    fileCount: number;
    classCount: number;
    methodCount: number;
    /** Capability ids detected, sorted (for the diff). */
    capabilityIds: string[];
  };
}

/** Is the optional `arkanalyzer` dependency installed and loadable? */
export function isArkAnalyzerAvailable(): boolean {
  return loadArkAnalyzer() !== null;
}

/**
 * Build the symbol-level target AppGraph for a generated HarmonyOS root (the
 * whole `.migration/harmony` tree, or a single module dir). Returns `null` on
 * ANY failure so the caller falls back to the phase-1 regex path.
 */
export function buildArkTargetGraph(generatedRoot: string): ArkTargetGraph | null {
  const ak = loadArkAnalyzer();
  if (!ak) return null;

  let scene: ArkScene;
  try {
    const config = new ak.SceneConfig();
    config.buildFromProjectDir(generatedRoot);
    if (config.getProjectFiles().length === 0) return null; // nothing to analyze
    scene = new ak.Scene();
    scene.buildSceneFromProjectDir(config);
    // Type inference is best-effort; it degrades without an OHOS SDK (never fatal).
    try {
      scene.inferTypes();
    } catch {
      /* structural graph is still usable */
    }
  } catch {
    return null; // Scene build threw — degrade to regex.
  }

  return extractTargetGraph(scene);
}

/** Walk a built Scene and lift the symbol-level target AppGraph (deterministic). */
function extractTargetGraph(scene: ArkScene): ArkTargetGraph {
  const files = scene.getFiles();
  const classes = scene.getClasses().filter((c) => !isSynthetic(c.getName()));
  const methods = scene.getMethods().filter((m) => !isSynthetic(m.getName()));

  const capabilityIds = new Set<string>();

  // 1) Capabilities from real @ohos.*/@kit.* imports (precise to the import site).
  for (const file of files) {
    for (const from of importFroms(file)) {
      const cap = capabilityForImport(from);
      if (cap) capabilityIds.add(cap);
    }
  }

  // 2) Screens from @Entry/@Component structs; a component implies ui.declarative.
  const screenById = new Map<string, AppNode>();
  const exports: ArkExport[] = [];
  for (const cls of classes) {
    const name = cls.getName();
    const category = safeNum(() => cls.getCategory());
    const decorators = classDecorators(cls);
    const isComponent =
      category === CATEGORY_STRUCT &&
      (decorators.includes('Component') ||
        decorators.includes('ComponentV2') ||
        decorators.includes('Entry'));

    if (isComponent) {
      capabilityIds.add('ui.declarative');
      const matchKey = screenMatchKey(name);
      const id = makeNodeId('harmony', 'Screen', matchKey);
      screenById.set(id, {
        id,
        kind: 'Screen',
        matchKey,
        name,
        platform: 'harmony',
        subtype: decorators.includes('Entry') ? 'entry-page' : 'component',
        provenance: 'source-static',
        fidelity: 'source-project',
        confidence: 0.9,
        attrs: { file: fileName(cls), decorators },
      });
    }

    if (safeBool(() => cls.isExport())) {
      exports.push({
        name,
        kind: kindOfCategory(category),
        signature: safeStr(() => cls.getSignature?.().toString()) || name,
        file: fileName(cls),
        isComponent,
        fields: classFields(cls),
      });
    }
  }

  // 3) Top-level exported functions — ArkAnalyzer hangs them on the synthetic
  //    default class (%dflt), so the classes loop above never sees them.
  for (const m of methods) {
    const declaring = m.getDeclaringArkClass?.();
    if (!declaring || !isSynthetic(safeStr(() => declaring.getName()))) continue;
    if (!safeBool(() => m.isExport?.() ?? false)) continue;
    exports.push({
      name: m.getName(),
      kind: 'function',
      signature: m.getName(),
      file: fileName(declaring),
      isComponent: false,
      fields: [],
    });
  }

  const capabilityNodes = [...capabilityIds].sort().map((id) => harmonyCapabilityNode(id));

  return {
    capabilityNodes,
    screenNodes: [...screenById.values()].sort((a, b) => a.id.localeCompare(b.id)),
    exports: exports.sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file)),
    structural: {
      buildOk: true,
      fileCount: files.length,
      classCount: classes.length,
      methodCount: methods.length,
      capabilityIds: [...capabilityIds].sort(),
    },
  };
}

/** A HarmonyOS Capability node keyed on the SAME `capability:<id>` as the source. */
function harmonyCapabilityNode(id: string): AppNode {
  const matchKey = `capability:${id}`;
  return {
    id: makeNodeId('harmony', 'Capability', matchKey),
    kind: 'Capability',
    matchKey,
    name: id,
    platform: 'harmony',
    provenance: 'source-static',
    fidelity: 'source-project',
    confidence: 0.9,
  };
}

/** The capability an `@ohos.*`/`@kit.*` import path implies, or null. */
function capabilityForImport(from: string): string | null {
  for (const { spec, markers } of VERIFIABLE_SPECS) {
    for (const marker of markers) {
      if (from === marker || from.startsWith(`${marker}.`)) return spec.id;
    }
  }
  return null;
}

// --- ArkAnalyzer surface (structurally-typed; the dep has no shipped .d.ts we import) ---

interface ArkScene {
  getFiles(): ArkFile[];
  getClasses(): ArkClass[];
  getMethods(): ArkMethod[];
  buildSceneFromProjectDir(config: unknown): void;
  inferTypes(): void;
}
interface ArkFile {
  getImportInfos?(): ArkImport[];
}
interface ArkImport {
  getFrom?(): string | undefined;
  getImportFrom?(): string | undefined;
}
interface ArkClass {
  getName(): string;
  getCategory(): number;
  isExport(): boolean;
  getSignature?(): { toString(): string };
  getDecorators?(): Array<{ getKind?(): string; toString(): string }>;
  getDeclaringArkFile?(): { getName?(): string };
  getFields?(): Array<{ getName?(): string }>;
}
interface ArkMethod {
  getName(): string;
  isExport?(): boolean;
  getDeclaringArkClass?(): ArkClass;
}
interface ArkAnalyzerModule {
  SceneConfig: new () => {
    buildFromProjectDir(dir: string): void;
    getProjectFiles(): unknown[];
  };
  Scene: new () => ArkScene;
}

let cachedModule: ArkAnalyzerModule | null | undefined;

/** Indirect require so the optional dep isn't statically bundled (see llm.ts). */
function loadArkAnalyzer(): ArkAnalyzerModule | null {
  if (cachedModule !== undefined) return cachedModule;
  try {
    const requireFn = eval('require') as NodeRequire;
    cachedModule = requireFn('arkanalyzer') as ArkAnalyzerModule;
  } catch {
    cachedModule = null;
  }
  return cachedModule;
}

function importFroms(file: ArkFile): string[] {
  let infos: ArkImport[];
  try {
    infos = file.getImportInfos?.() ?? [];
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const info of infos) {
    const from = safeStr(() => info.getFrom?.()) || safeStr(() => info.getImportFrom?.());
    if (from) out.push(from);
  }
  return out;
}

/** Declared field/property names of a target class (best-effort; [] on any failure). */
function classFields(cls: ArkClass): string[] {
  try {
    const fields = cls.getFields?.() ?? [];
    return fields
      .map((f) => safeStr(() => f.getName?.()))
      .filter((n) => n.length > 0 && !isSynthetic(n))
      .sort();
  } catch {
    return [];
  }
}

function classDecorators(cls: ArkClass): string[] {
  try {
    const decos = cls.getDecorators?.() ?? [];
    return decos
      .map((d) => (d.getKind ? d.getKind() : d.toString()))
      .filter((k): k is string => typeof k === 'string' && k.length > 0);
  } catch {
    return [];
  }
}

function fileName(cls: ArkClass): string {
  return safeStr(() => cls.getDeclaringArkFile?.()?.getName?.()) || '';
}

function kindOfCategory(category: number): ArkExportKind {
  if (category === CATEGORY_STRUCT) return 'struct';
  if (category === CATEGORY_INTERFACE) return 'interface';
  if (category === CATEGORY_CLASS) return 'class';
  return 'class';
}

/** ArkAnalyzer uses `%dflt`, `%AM0$…` etc. for synthetic/anonymous members. */
function isSynthetic(name: string): boolean {
  return !name || name.startsWith('%');
}

function safeStr(fn: () => string | undefined): string {
  try {
    return fn() ?? '';
  } catch {
    return '';
  }
}
function safeNum(fn: () => number): number {
  try {
    return fn();
  } catch {
    return -1;
  }
}
function safeBool(fn: () => boolean): boolean {
  try {
    return fn() === true;
  } catch {
    return false;
  }
}
