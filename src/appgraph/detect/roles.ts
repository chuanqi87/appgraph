/**
 * U1 · annotation / component-role detection (closes phase-1 gap #4).
 *
 * codegraph leaves `Node.decorators` empty for Kotlin, so we recover each
 * symbol's leading annotations from its source span and normalize them to a
 * single migration-relevant ROLE (viewmodel / screen / entity / dao / di-* / …).
 * A role tells the LLM what a class semantically IS — the difference between
 * "translate this class" and "translate this ViewModel that exposes StateFlow
 * and is injected with these repositories".
 *
 * PURE + reusable: the structural stage aggregates roles into ArchModule attrs
 * (deterministic, hashed), and the migrate/context stage calls the SAME detector
 * to label each interface member. No LLM, no graph mutation here.
 */

import { Node } from '../../types';
import { hasInjectConstructor, leadingAnnotations, superTypes } from './kotlin-source';
import { isShippableJvmNode, ReadCode } from './shared';

export type ComponentRole =
  | 'app-entry' // @HiltAndroidApp (Application)
  | 'entry-host' // @AndroidEntryPoint (Activity/Fragment host)
  | 'viewmodel' // @HiltViewModel or extends ViewModel
  | 'screen' // @Composable fun named *Screen/*Route/*Page
  | 'composable-ui' // any other @Composable
  | 'di-module' // @Module (Hilt/Dagger)
  | 'di-provider' // @Provides / @Binds function
  | 'dao' // @Dao (Room)
  | 'entity' // @Entity (Room)
  | 'serializable-model' // @Serializable data class
  | 'repository' // *Repository (interface/impl)
  | 'usecase'; // *UseCase

export interface RoleInfo {
  role: ComponentRole;
  /** Annotation simple-names observed on the declaration. */
  annotations: string[];
  /** Confidence: annotation-driven = high, name/supertype heuristic = medium. */
  confidence: number;
}

/** Node kinds that can carry a component role. */
const ROLE_KINDS = new Set(['class', 'interface', 'function', 'object', 'struct']);

const COMPOSABLE_SCREEN_RE = /(Screen|Route|Page|Dialog)$/;

/**
 * Classify one symbol's role from its source span, or null if it carries no
 * migration-relevant role. Priority is most-specific-first so a node gets a
 * single deterministic role.
 */
export function classifyRole(node: Node, code: string): RoleInfo | null {
  if (!ROLE_KINDS.has(node.kind)) return null;
  const anno = leadingAnnotations(code);
  const has = (a: string): boolean => anno.includes(a);
  const supers = node.kind === 'function' ? [] : superTypes(code);
  const extendsAny = (re: RegExp): boolean => supers.some((s) => re.test(s));

  // Annotation-driven (high confidence).
  if (has('HiltAndroidApp')) return { role: 'app-entry', annotations: anno, confidence: 0.95 };
  if (has('AndroidEntryPoint')) return { role: 'entry-host', annotations: anno, confidence: 0.9 };
  if (has('HiltViewModel')) return { role: 'viewmodel', annotations: anno, confidence: 0.95 };
  if (has('Dao')) return { role: 'dao', annotations: anno, confidence: 0.95 };
  if (has('Entity')) return { role: 'entity', annotations: anno, confidence: 0.95 };
  if (has('Module')) return { role: 'di-module', annotations: anno, confidence: 0.9 };
  if (has('Provides') || has('Binds')) {
    return { role: 'di-provider', annotations: anno, confidence: 0.9 };
  }
  if (has('Composable')) {
    const role = COMPOSABLE_SCREEN_RE.test(node.name) ? 'screen' : 'composable-ui';
    return { role, annotations: anno, confidence: 0.9 };
  }
  if (has('Serializable') && /\bdata\b/.test(sanitizedHeader(code))) {
    return { role: 'serializable-model', annotations: anno, confidence: 0.85 };
  }

  // Supertype / name heuristics (medium confidence) — architecturally reliable here.
  if (extendsAny(/ViewModel$/)) return { role: 'viewmodel', annotations: anno, confidence: 0.7 };
  if (node.name.endsWith('UseCase')) return { role: 'usecase', annotations: anno, confidence: 0.6 };
  if (/Repository(Impl)?$/.test(node.name)) {
    return { role: 'repository', annotations: anno, confidence: 0.6 };
  }
  // An @Inject-constructor class with no other role still signals DI participation.
  if (hasInjectConstructor(code)) {
    return { role: 'repository', annotations: [...anno, 'Inject'], confidence: 0.4 };
  }
  return null;
}

/**
 * Android View base classes whose subclass is a CUSTOM VIEW (P1-6). ArkUI has
 * no UI class inheritance, so such a class needs an inheritance→composition
 * rewrite (`@Component`/`@Builder`) rather than a 1:1 translation. Matched on the
 * SUPERTYPE base name: the broad `*View`/`*Layout`/`*Button`/`*Bar` suffixes
 * cover the containers and widgets, and the explicit set catches the widget
 * bases that don't carry one of those suffixes.
 */
const VIEW_SUPER_EXPLICIT = new Set([
  'View',
  'ViewGroup',
  'EditText',
  'CheckBox',
  'RadioButton',
  'Spinner',
  'Chip',
  'Switch',
  'ToggleButton',
  'NumberPicker',
  'Chronometer',
  'Gallery',
  'Space',
  'CompoundButton',
  'Toolbar', // ends in lowercase 'bar' — not caught by the *Bar suffix
]);
const VIEW_SUPER_SUFFIX = /(?:View|Layout|Button|Bar)$/;

/** Whether a supertype base name is an Android View base (custom-View detection). */
export function isAndroidViewSuper(superBaseName: string): boolean {
  if (VIEW_SUPER_EXPLICIT.has(superBaseName)) return true;
  // A bare 'Bar' suffix on a short word (e.g. 'Bar', 'Car') is too loose; require
  // the recognized widget/container suffixes on a name of reasonable length.
  return superBaseName.length > 3 && VIEW_SUPER_SUFFIX.test(superBaseName);
}

/** Just the class-header text (up to the first `{` or `(`), for cheap `data`/keyword checks. */
function sanitizedHeader(code: string): string {
  const cut = Math.min(
    ...[code.indexOf('{'), code.indexOf('(')].filter((i) => i >= 0).concat([code.length])
  );
  return code.slice(0, cut);
}

export interface RoleResult {
  /** code node id → role. */
  byNodeId: Map<string, RoleInfo>;
  /** qualifiedName → role (for the context assembler, which keys by qname). */
  byQName: Map<string, RoleInfo>;
}

/**
 * Detect roles for every role-bearing symbol in the graph. Iterates nodes in a
 * stable order and reads each span once. Non-source (test) symbols are skipped.
 */
export function detectRoles(nodes: Node[], readCode: ReadCode): RoleResult {
  const byNodeId = new Map<string, RoleInfo>();
  const byQName = new Map<string, RoleInfo>();
  const sorted = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  for (const node of sorted) {
    if (!ROLE_KINDS.has(node.kind)) continue;
    if (!isShippableJvmNode(node)) continue;
    const code = readCode(node);
    if (code === null) continue;
    const info = classifyRole(node, code);
    if (!info) continue;
    byNodeId.set(node.id, info);
    byQName.set(node.qualifiedName, info);
  }
  return { byNodeId, byQName };
}

/** Aggregate a role map to per-module counts, given code node → module id. */
export function aggregateRolesByModule(
  roles: Map<string, RoleInfo>,
  nodeToModuleId: Map<string, string>
): Map<string, Record<string, number>> {
  const byModule = new Map<string, Record<string, number>>();
  for (const [nodeId, info] of roles) {
    const moduleId = nodeToModuleId.get(nodeId);
    if (!moduleId) continue;
    let counts = byModule.get(moduleId);
    if (!counts) {
      counts = {};
      byModule.set(moduleId, counts);
    }
    counts[info.role] = (counts[info.role] ?? 0) + 1;
  }
  // Sort each count object's keys for determinism when serialized.
  for (const [moduleId, counts] of byModule) {
    byModule.set(moduleId, sortedRecord(counts));
  }
  return byModule;
}

function sortedRecord(rec: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(rec).sort()) out[k] = rec[k]!;
  return out;
}
