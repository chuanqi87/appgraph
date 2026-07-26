/**
 * U3 · DataModel — HarmonyOS global state models.
 *
 * HarmonyOS has no Room-style annotated entity. Its persistable/shared data
 * models are `@ObservedV2` classes bound to a global key by TYPE:
 *
 *   AppStorageV2.connect(GlobalState, 'GlobalState', () => new GlobalState())
 *   PersistenceV2.connect(CurrentCity, AppStorageMap.CURRENT_CITY, () => …)
 *
 *   @ObservedV2 export class GlobalState {
 *     @Trace public rootPageActiveTabId: string = '';
 *   }
 *
 * This is the dominant state mechanism in the corpus (`AppStorageV2` 4,182 +
 * `PersistenceV2` 1,306 uses over 3,606 `@ObservedV2` classes), and it is the
 * closest HarmonyOS analogue to an Android entity/DataStore: a named, typed,
 * app-wide record with a declared field schema.
 *
 * `AppStorageV2` is in-memory, `PersistenceV2` survives restarts — the
 * distinction a migration must preserve, so it is kept as the node subtype.
 *
 * Precise-or-drop: a type argument that does not resolve to an `@ObservedV2`
 * class yields NO node. A DataModel is a migration contract; a guessed one is
 * worse than an acknowledged gap.
 */

import {
  AppEdge,
  AppNode,
  CoverageWarning,
  dataModelMatchKey,
  makeEdgeId,
  makeNodeId,
} from '../schema';
import { Node } from '../../types';
import { CodeSymbolGraph } from '../graph-reader';
import { enumMemberStringValue, tracedFields } from './arkts-source';
import type { ModuleRef } from './manifest-capabilities';
import type { ReadCode } from './shared';

/**
 * `AppStorageV2.connect(Type, …)` / `PersistenceV2.connect(Type, …)`.
 *
 * The explicit type-argument form `connect<Type>(Type, …)` is common (84 corpus
 * uses across 8 projects) and must be accepted: requiring `connect(` outright
 * dropped 9 models — three projects' whole `GlobalInfoModel` — with no warning,
 * because a regex that never fires produces nothing to warn about.
 */
const CONNECT_RE =
  /\b(AppStorageV2|PersistenceV2)\s*\.\s*(?:connect|globalConnect)\s*(?:<[^>]*>\s*)?\(\s*([A-Z]\w*)\s*(?:,\s*([^,)]+))?/g;

export interface HarmonyStateResult {
  dataModelNodes: AppNode[];
  /** app_contains: ArchModule → DataModel. */
  containsEdges: AppEdge[];
  warnings: CoverageWarning[];
  stats: {
    dataModels: number;
    persisted: number;
    unresolvedTypes: number;
  };
}

export function detectHarmonyState(
  reader: CodeSymbolGraph,
  readCode: ReadCode,
  modules: ModuleRef[]
): HarmonyStateResult {
  const nodes = reader.getAllNodes();

  // `@ObservedV2` classes by simple name — the only valid connect targets.
  const observedByName = new Map<string, Node>();
  for (const n of nodes) {
    if (n.kind !== 'class') continue;
    if (!(n.decorators ?? []).includes('ObservedV2')) continue;
    if (!observedByName.has(n.name)) observedByName.set(n.name, n);
  }
  if (observedByName.size === 0) {
    return { dataModelNodes: [], containsEdges: [], warnings: [], stats: emptyStats() };
  }

  const enumIndex = buildEnumStringIndex(nodes, readCode);
  const models = new Map<string, AppNode>();
  const warnings: CoverageWarning[] = [];
  const unresolved = new Set<string>();

  // File-anchor index, built once — `nodes.find(...)` per file is O(files × nodes).
  const fileAnchors = new Map<string, Node>();
  for (const n of nodes) {
    if (n.kind === 'file' && !fileAnchors.has(n.filePath)) fileAnchors.set(n.filePath, n);
  }

  for (const [file, anchor] of fileAnchors) {
    if (!file.endsWith('.ets') && !file.endsWith('.ts')) continue;
    const source = readCode(anchor);
    // Cheap gate. Must match the generic form too (`connect<T>(`), and
    // `globalConnect`, or the regex below never gets a chance to run.
    if (!source || !/V2\s*\.\s*(?:connect|globalConnect)/.test(source)) continue;

    CONNECT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CONNECT_RE.exec(source))) {
      const store = m[1]!;
      const typeName = m[2]!;
      const target = observedByName.get(typeName);
      if (!target) {
        unresolved.add(typeName);
        continue;
      }

      const key = resolveStateKey(m[3], typeName, enumIndex);
      const code = readCode(target);
      const fields = code ? tracedFields(code) : [];
      const persisted = store === 'PersistenceV2';

      const matchKey = dataModelMatchKey(typeName);
      const id = makeNodeId('harmony', 'DataModel', matchKey);
      const existing = models.get(id);
      const keys = new Set<string>([
        ...((existing?.attrs?.stateKeys as string[] | undefined) ?? []),
        ...(key ? [key] : []),
      ]);

      models.set(id, {
        id,
        kind: 'DataModel',
        matchKey,
        name: typeName,
        platform: 'harmony',
        // The in-memory/persisted split is the migration-relevant distinction.
        subtype: persisted || existing?.subtype === 'persistence' ? 'persistence' : 'app-storage',
        platformRef: { file: target.filePath, symbol: typeName },
        provenance: 'source-static',
        fidelity: 'source-project',
        confidence: 0.9,
        attrs: {
          file: target.filePath,
          fields,
          stateKeys: [...keys].sort(),
          stores: [
            ...new Set([...((existing?.attrs?.stores as string[] | undefined) ?? []), store]),
          ].sort(),
        },
      });
    }
  }

  for (const name of [...unresolved].sort()) {
    warnings.push({
      message:
        `AppStorageV2/PersistenceV2.connect(${name}, …) 的类型未解析到 @ObservedV2 类——` +
        `该全局状态模型未进入数据模型清单(可能定义在未索引的依赖中)`,
    });
  }

  // Module attribution by longest matching dir prefix.
  const containsEdges: AppEdge[] = [];
  const sorted = [...modules].sort((a, b) => b.dir.length - a.dir.length);
  for (const model of models.values()) {
    const file = model.platformRef?.file ?? '';
    const owner = sorted.find((m) => file === m.dir || file.startsWith(`${m.dir}/`));
    if (!owner) continue;
    containsEdges.push({
      id: makeEdgeId('app_contains', owner.id, model.id),
      kind: 'app_contains',
      from: owner.id,
      to: model.id,
      provenance: 'source-static',
      confidence: 0.9,
    });
  }

  const dataModelNodes = [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
  return {
    dataModelNodes,
    containsEdges: containsEdges.sort((a, b) => a.id.localeCompare(b.id)),
    warnings,
    stats: {
      dataModels: dataModelNodes.length,
      persisted: dataModelNodes.filter((n) => n.subtype === 'persistence').length,
      unresolvedTypes: unresolved.size,
    },
  };
}

/**
 * The global key a model is bound to.
 *
 * `connect(T, factory)` omits the key, which defaults to the type name;
 * `connect(T, key, factory)` gives it as a literal or — commonly — a constant
 * such as `AppStorageMap.CURRENT_CITY`, resolved through the same enum index the
 * navigation synthesizer uses.
 */
function resolveStateKey(
  raw: string | undefined,
  typeName: string,
  enumIndex: Map<string, string>
): string | null {
  const arg = raw?.trim();
  if (!arg) return typeName; // 2-arg form: key defaults to the type name
  if (/^\(|=>|^function\b/.test(arg)) return typeName; // that was the factory
  const literal = /^(['"])(.*)\1$/.exec(arg);
  if (literal) return literal[2]!;
  const member = /^([A-Z]\w*)\.([A-Za-z_]\w*)$/.exec(arg);
  if (member) return enumIndex.get(`${member[1]}.${member[2]}`) ?? null;
  return null; // computed at runtime — recorded as "no known key"
}

/** `Enum.MEMBER` → string value, for string-valued enums (state key constants). */
function buildEnumStringIndex(nodes: Node[], readCode: ReadCode): Map<string, string> {
  const index = new Map<string, string>();
  const conflicted = new Set<string>();
  const byFile = new Map<string, Node[]>();
  for (const n of nodes) {
    const bucket = byFile.get(n.filePath);
    if (bucket) bucket.push(n);
    else byFile.set(n.filePath, [n]);
  }

  for (const n of nodes) {
    if (n.kind !== 'enum') continue;
    for (const member of byFile.get(n.filePath) ?? []) {
      if (member.kind !== 'enum_member') continue;
      if (member.startLine < n.startLine || member.endLine > n.endLine) continue;
      const code = readCode(member);
      const value = code ? enumMemberStringValue(code) : null;
      if (!value) continue;
      const key = `${n.name}.${member.name}`;
      if (conflicted.has(key)) continue;
      const prev = index.get(key);
      if (prev !== undefined && prev !== value) {
        index.delete(key);
        conflicted.add(key);
      } else {
        index.set(key, value);
      }
    }
  }
  return index;
}

function emptyStats(): HarmonyStateResult['stats'] {
  return { dataModels: 0, persisted: 0, unresolvedTypes: 0 };
}
