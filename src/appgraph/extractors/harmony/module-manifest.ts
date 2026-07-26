/**
 * `src/main/module.json5` — HarmonyOS's AndroidManifest.
 *
 * Unlike Android (one merged manifest per app), EVERY module carries one, so the
 * structural facts are distributed: measured across 1,146 real modules, 478
 * declare a `routerMap` and 343 declare permissions. A HAR's manifest can be as
 * small as `{ "module": { "name": "x", "type": "har", "deviceTypes": [...] } }`.
 *
 * Correspondence to Android:
 *   mainElement          ≈ the LAUNCHER activity
 *   abilities[]          ≈ <activity>       (srcEntry = the code behind it)
 *   extensionAbilities[] ≈ <service>/<receiver>/<provider> (type: form / backup / …)
 *   skills[]             ≈ <intent-filter>  (actions/entities/uris, domainVerify)
 *   requestPermissions[] ≈ <uses-permission>
 *   metadata[]           ≈ <meta-data>
 *   routerMap / pages    ≈ res/navigation/nav_graph.xml (but per-module, and by
 *                          `$profile:` reference — the FILENAME is not fixed)
 *
 * This module only PARSES; mapping to AppGraph nodes/edges is `manifest.ts`.
 */

import { asArray, asObject, asString, readJson5, type Json5Issue } from './json5';

/** One `<data>`-equivalent URI matcher inside a skill. */
export interface HarmonyUri {
  scheme?: string;
  host?: string;
  port?: string;
  path?: string;
  pathStartWith?: string;
  pathRegex?: string;
}

/** One `<intent-filter>`-equivalent. */
export interface HarmonySkill {
  actions: string[];
  entities: string[];
  uris: HarmonyUri[];
  /** ≈ android:autoVerify — App Linking domain ownership check. */
  domainVerify: boolean;
}

export interface HarmonyMetadata {
  name?: string;
  value?: string;
  /** `$profile:xxx` reference to a `resources/<qualifier>/profile/xxx.json` file. */
  resource?: string;
}

/** An `abilities[]` (UIAbility) or `extensionAbilities[]` entry. */
export interface HarmonyAbility {
  name: string;
  /** `./ets/entryability/EntryAbility.ets` — module-relative path to the code. */
  srcEntry?: string;
  /** Only set for extensionAbilities: `form`, `backup`, `service`, … */
  extensionType?: string;
  exported: boolean;
  skills: HarmonySkill[];
  metadata: HarmonyMetadata[];
  label?: string;
  description?: string;
}

export interface ModuleManifest {
  name?: string;
  /** `entry` (HAP) | `har` | `shared` (HSP) | `feature`. */
  type?: string;
  /** The ability launched when the app starts ≈ LAUNCHER activity name. */
  mainElement?: string;
  deviceTypes: string[];
  /** `$profile:route_map` — Navigation route table reference (name NOT fixed). */
  routerMap?: string;
  /** `$profile:main_pages` — legacy router page list reference. */
  pages?: string;
  installationFree: boolean;
  requestPermissions: Array<{ name: string; reason?: string }>;
  metadata: HarmonyMetadata[];
  querySchemes: string[];
  abilities: HarmonyAbility[];
  extensionAbilities: HarmonyAbility[];
  issues: Json5Issue[];
}

const EMPTY_MANIFEST: ModuleManifest = {
  deviceTypes: [],
  installationFree: false,
  requestPermissions: [],
  metadata: [],
  querySchemes: [],
  abilities: [],
  extensionAbilities: [],
  issues: [],
};

/**
 * True for a `src/main/module.json5` path. Excludes `src/ohosTest/module.json5`
 * (976 of them in the corpus, all `type:"feature"` with `_test`-suffixed names) —
 * counting those would literally double every module tally.
 */
export function isMainModuleManifest(relPath: string): boolean {
  return relPath.replace(/\\/g, '/').endsWith('src/main/module.json5');
}

/** Parse a `module.json5`. Missing/!object → empty manifest carrying the issues. */
export function readModuleManifest(absPath: string): ModuleManifest {
  const { value, issues } = readJson5(absPath);
  const root = asObject(value);
  const mod = root ? asObject(root.module) : null;
  if (!mod) return { ...EMPTY_MANIFEST, issues };

  return {
    name: asString(mod.name),
    type: asString(mod.type),
    mainElement: asString(mod.mainElement),
    deviceTypes: asArray(mod.deviceTypes).map(asString).filter(isString),
    routerMap: asString(mod.routerMap),
    pages: asString(mod.pages),
    installationFree: mod.installationFree === true,
    requestPermissions: readPermissions(mod.requestPermissions),
    metadata: readMetadata(mod.metadata),
    querySchemes: asArray(mod.querySchemes).map(asString).filter(isString),
    abilities: asArray(mod.abilities).map((a) => readAbility(a, undefined)).filter(isAbility),
    extensionAbilities: asArray(mod.extensionAbilities)
      .map((a) => readAbility(a, 'extension'))
      .filter(isAbility),
    issues,
  };
}

function readPermissions(raw: unknown): Array<{ name: string; reason?: string }> {
  const out: Array<{ name: string; reason?: string }> = [];
  for (const entry of asArray(raw)) {
    const obj = asObject(entry);
    // Both `{name: "..."}` and a bare string are accepted in the wild.
    const name = obj ? asString(obj.name) : asString(entry);
    if (!name) continue;
    out.push({ name, reason: obj ? asString(obj.reason) : undefined });
  }
  return out;
}

function readMetadata(raw: unknown): HarmonyMetadata[] {
  const out: HarmonyMetadata[] = [];
  for (const entry of asArray(raw)) {
    const obj = asObject(entry);
    if (!obj) continue;
    out.push({
      name: asString(obj.name),
      value: asString(obj.value),
      resource: asString(obj.resource),
    });
  }
  return out;
}

function readAbility(raw: unknown, kind: 'extension' | undefined): HarmonyAbility | null {
  const obj = asObject(raw);
  if (!obj) return null;
  const name = asString(obj.name);
  if (!name) return null;
  return {
    name,
    srcEntry: asString(obj.srcEntry) ?? asString(obj.srcEntrance),
    extensionType: kind === 'extension' ? asString(obj.type) : undefined,
    exported: obj.exported === true,
    skills: readSkills(obj.skills),
    metadata: readMetadata(obj.metadata),
    label: asString(obj.label),
    description: asString(obj.description),
  };
}

function readSkills(raw: unknown): HarmonySkill[] {
  const out: HarmonySkill[] = [];
  for (const entry of asArray(raw)) {
    const obj = asObject(entry);
    if (!obj) continue;
    out.push({
      actions: asArray(obj.actions).map(asString).filter(isString),
      entities: asArray(obj.entities).map(asString).filter(isString),
      uris: asArray(obj.uris).map(readUri).filter(isUri),
      domainVerify: obj.domainVerify === true,
    });
  }
  return out;
}

function readUri(raw: unknown): HarmonyUri | null {
  const obj = asObject(raw);
  if (!obj) return null;
  const uri: HarmonyUri = {
    scheme: asString(obj.scheme),
    host: asString(obj.host),
    port: asString(obj.port),
    path: asString(obj.path),
    pathStartWith: asString(obj.pathStartWith),
    pathRegex: asString(obj.pathRegex),
  };
  return uri.scheme || uri.host || uri.path || uri.pathStartWith || uri.pathRegex ? uri : null;
}

function isString(v: string | undefined): v is string {
  return typeof v === 'string' && v.length > 0;
}
function isAbility(v: HarmonyAbility | null): v is HarmonyAbility {
  return v !== null;
}
function isUri(v: HarmonyUri | null): v is HarmonyUri {
  return v !== null;
}
