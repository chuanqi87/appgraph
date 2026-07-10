/**
 * U3 · data models + field schema.
 *
 * Data models are migration first-class citizens: a Room `@Entity` becomes a
 * HarmonyOS `relationalStore` table, a `@Serializable` DTO becomes an ArkTS
 * interface. Phase-2 had class nodes but no "this is an entity" mark and no
 * fields, so the target-side RDB/interface generation had no source anchor and
 * V2's field-level fidelity check had nothing to compare.
 *
 * This recovers each model + its FIELD SCHEMA (name / type / nullability /
 * key + column mapping) from the primary constructor, deterministically, and
 * emits `DataModel` nodes carrying `attrs.fields`.
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
import { annotationArg, KotlinField, leadingAnnotations, parsePrimaryConstructor, superTypes } from './kotlin-source';
import { javaFields, javaSuperTypes } from './java-source';
import { DetectContext, isShippableJvmNode, ReadCode } from './shared';

/** One field of a data model, normalized for cross-platform schema diffing. */
export interface FieldSchema {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  /** Persisted column / serialized name when it differs from `name`. */
  mappedName?: string;
  hasDefault: boolean;
}

/** Supertypes that mark a class as a navigation route key, not a data model. */
const NAV_KEY_RE = /^(NavKey|NavigationKey|Route|Screen)$/;

export interface EntityResult {
  dataModelNodes: AppNode[];
  containsEdges: AppEdge[];
  warnings: CoverageWarning[];
  stats: { entityCount: number; serializableCount: number; fieldCount: number };
}

/** Detect data models and their field schemas. */
export function detectEntities(nodes: Node[], readCode: ReadCode, ctx: DetectContext): EntityResult {
  const byMatchKey = new Map<string, AppNode>();
  const containsById = new Map<string, AppEdge>();
  const warnings: CoverageWarning[] = [];
  let entityCount = 0;
  let serializableCount = 0;
  let fieldCount = 0;

  const classes = [...nodes]
    .filter((n) => n.kind === 'class' && isShippableJvmNode(n))
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const node of classes) {
    const code = readCode(node);
    if (code === null) continue;
    const model = classifyModel(node, code);
    if (model === null) continue;
    if (model === 'warn') {
      warnings.push({
        message: `U3 · ${node.name} 标注为数据模型但未解析出字段(可能不是 data class 或字段在类体内)`,
        ref: { file: node.filePath, symbol: node.name },
      });
      continue;
    }
    fieldCount += model.fields.length;
    if (model.subtype === 'entity') entityCount++;
    else serializableCount++;

    const matchKey = dataModelMatchKey(node.name);
    if (byMatchKey.has(matchKey)) continue; // stable: first id-sorted wins
    const id = makeNodeId('android', 'DataModel', matchKey);
    byMatchKey.set(matchKey, {
      id,
      kind: 'DataModel',
      matchKey,
      name: node.name,
      platform: 'android',
      subtype: model.subtype,
      provenance: 'source-static',
      fidelity: 'source-project',
      confidence: 0.9,
      platformRef: { file: node.filePath, symbol: node.name },
      attrs: {
        framework: model.framework,
        ...(model.tableName ? { tableName: model.tableName } : {}),
        fieldCount: model.fields.length,
        fields: model.fields,
      },
    });

    const moduleId = ctx.nodeToModuleId.get(node.id);
    if (moduleId) {
      const edgeId = makeEdgeId('app_contains', moduleId, id);
      if (!containsById.has(edgeId)) {
        containsById.set(edgeId, {
          id: edgeId,
          kind: 'app_contains',
          from: moduleId,
          to: id,
          provenance: 'source-static',
          confidence: 0.85,
          attrs: { kind: 'datamodel' },
        });
      }
    }
  }

  return {
    dataModelNodes: [...byMatchKey.values()].sort((a, b) => a.id.localeCompare(b.id)),
    containsEdges: [...containsById.values()].sort((a, b) => a.id.localeCompare(b.id)),
    warnings,
    stats: { entityCount, serializableCount, fieldCount },
  };
}

/** A class classified as a data model + the facts needed to emit its node. */
interface ModelClass {
  subtype: 'entity' | 'serializable';
  framework: string;
  fields: FieldSchema[];
  tableName: string | null;
}

/**
 * Behavior/infra class-name suffixes that are NEVER data models — a Java class
 * that merely `implements Serializable` is only a data model if it is a data
 * carrier, not a `…Manager`/`…Service`/`…Adapter`. This bound keeps the
 * un-annotated Java POJO family from manufacturing false V2 entity gaps.
 */
const BEHAVIOR_NAME_RE =
  /(Manager|Service|Adapter|Helper|Activity|Fragment|Handler|Controller|Factory|Builder|Provider|Presenter|ViewModel|Repository|UseCase|Interactor|Util|Utils|Test|Dao|Database|Client|Api|Mapper|Serializer|Deserializer|Parser|Loader|Worker|Receiver|Binder|Callback|Listener|Observer|Task|Runnable|Exception|Error|Config|Module|Component|Fixture)$/;

/**
 * Classify a class as a data model. Returns the model facts to emit, `'warn'`
 * when a Kotlin class is annotated as a model but no fields could be recovered
 * (the existing coverage warning), or `null` when it is not a data model.
 *
 * Sources covered:
 *   - Room `@Entity` (Kotlin/Java), kotlinx `@Serializable`, Moshi `@JsonClass`,
 *     `@Parcelize` — annotation-gated, low false-positive risk.
 *   - Un-annotated Java POJOs that `implements Serializable`/`Parcelable` — a
 *     data-carrier signal, gated by `BEHAVIOR_NAME_RE` + a non-empty field set.
 */
function classifyModel(node: Node, code: string): ModelClass | 'warn' | null {
  return node.language === 'java' ? classifyJavaModel(node, code) : classifyKotlinModel(code);
}

function classifyKotlinModel(code: string): ModelClass | 'warn' | null {
  const anno = leadingAnnotations(code);
  const isEntity = anno.includes('Entity');
  const moshi = anno.includes('JsonClass');
  const parcelize = anno.includes('Parcelize');
  const kotlinxSer = anno.includes('Serializable');
  if (!isEntity && !moshi && !parcelize && !kotlinxSer) return null;
  // A `@Serializable`/`@Parcelize` object that is only a navigation route key is
  // product navigation (owned by U2), not a data model — exclude it here.
  if (!isEntity && superTypes(code).some((s) => NAV_KEY_RE.test(s))) return null;

  const raw = parsePrimaryConstructor(code);
  if (raw.length === 0) return 'warn';
  const framework = isEntity ? 'room' : moshi ? 'moshi' : parcelize ? 'parcelize' : 'kotlinx-serialization';
  return {
    subtype: isEntity ? 'entity' : 'serializable',
    framework,
    fields: raw.map((f) => toFieldSchema(f, code)),
    tableName: isEntity ? annotationArg(code, 'Entity', 'tableName') : null,
  };
}

function classifyJavaModel(node: Node, code: string): ModelClass | null {
  if (BEHAVIOR_NAME_RE.test(node.name)) return null;
  const anno = leadingAnnotations(code);
  const isEntity = anno.includes('Entity');
  const moshi = anno.includes('JsonClass');
  const serAnno = anno.includes('Serializable'); // kotlinx @Serializable on Java (rare)
  const supers = javaSuperTypes(code);
  const implementsData = supers.includes('Serializable') || supers.includes('Parcelable');
  if (!isEntity && !moshi && !serAnno && !implementsData) return null;

  // A fieldless Java class is not a usable data model — skip silently (no warn):
  // emitting it would create a target-side entity requirement with no schema.
  const raw = javaFields(code);
  if (raw.length === 0) return null;
  const framework = isEntity ? 'room' : moshi ? 'moshi' : 'java-pojo';
  return {
    subtype: isEntity ? 'entity' : 'serializable',
    framework,
    fields: raw.map((f) => toFieldSchema(f, code)),
    tableName: isEntity ? annotationArg(code, 'Entity', 'tableName') : null,
  };
}

/** Lift a raw Kotlin field to the normalized cross-platform field schema. */
function toFieldSchema(field: KotlinField, classCode: string): FieldSchema {
  const primaryKey = field.annotations.includes('PrimaryKey');
  const mappedName = perFieldName(field, classCode);
  const schema: FieldSchema = {
    name: field.name,
    type: field.type,
    nullable: field.nullable,
    primaryKey,
    hasDefault: field.hasDefault,
  };
  if (mappedName && mappedName !== field.name) schema.mappedName = mappedName;
  return schema;
}

/** Column/serialized name override from `@ColumnInfo(name=…)` / `@SerialName("…")`. */
function perFieldName(field: KotlinField, classCode: string): string | undefined {
  if (field.annotations.includes('ColumnInfo')) {
    const col = fieldScopedArg(classCode, field.name, 'ColumnInfo', 'name');
    if (col) return col;
  }
  if (field.annotations.includes('SerialName')) {
    const sn = fieldScopedSerialName(classCode, field.name);
    if (sn) return sn;
  }
  return undefined;
}

/**
 * Read a named arg of a per-field annotation by locating the field declaration
 * and scanning its immediate annotation prefix. Bounded to the field's own line
 * region so it never picks up another field's annotation.
 */
function fieldScopedArg(classCode: string, fieldName: string, annotation: string, arg: string): string | undefined {
  const region = fieldRegion(classCode, fieldName);
  if (region === null) return undefined;
  return annotationArg(region, annotation, arg) ?? undefined;
}

function fieldScopedSerialName(classCode: string, fieldName: string): string | undefined {
  const region = fieldRegion(classCode, fieldName);
  if (region === null) return undefined;
  const m = /@SerialName\s*\(\s*"([^"]*)"/.exec(region);
  return m ? m[1] : undefined;
}

/** The source slice from the previous field boundary up to `val/var <field>`. */
function fieldRegion(classCode: string, fieldName: string): string | null {
  const re = new RegExp(`(val|var)\\s+${fieldName}\\b`);
  const m = re.exec(classCode);
  if (!m) return null;
  const start = Math.max(0, classCode.lastIndexOf(',', m.index));
  return classCode.slice(start, m.index + m[0].length);
}
