/**
 * Deterministic `module.json5` → AppGraph extractor (structural truth).
 *
 * The Android analogue is `extractors/android/manifest.ts`; this emits the same
 * node kinds from HarmonyOS's per-module manifest:
 *
 *   mainElement ability   → AppEntry   (≈ the LAUNCHER activity)
 *   other abilities       → BackgroundComponent[ability]  (a UIAbility that is
 *                           not the entry — its pages surface via the Screen pass)
 *   extensionAbilities    → BackgroundComponent[form|backup|service|…]
 *   skills[].uris         → Resource   (deep link, ≈ <data> in an intent-filter)
 *   requestPermissions    → Permission + Capability
 *
 * Anything the manifest cannot settle — which screen actually exercises a
 * permission — is left to later passes and surfaced as a coverageWarning rather
 * than guessed.
 */

import {
  AppEdge,
  AppNode,
  CoverageWarning,
  capabilityMatchKey,
  componentMatchKey,
  makeEdgeId,
  makeNodeId,
  permissionMatchKey,
  resourceMatchKey,
} from '../../schema';
import { isCapabilityId } from '../../capabilities';
import { harmonyPermissionToCapability } from './capabilities';
import type { HarmonyAbility, HarmonySkill, HarmonyUri, ModuleManifest } from './module-manifest';
import type { HarmonyModule } from './project';

/** `entity.system.home` + the home action = the launcher entry, ≈ MAIN/LAUNCHER. */
const ENTITY_HOME = 'entity.system.home';
const ACTION_HOME = 'ohos.want.action.home';
/** ≈ android.intent.action.VIEW — the deep-link action. */
const ACTION_VIEW_DATA = 'ohos.want.action.viewData';

export interface HarmonyManifestExtraction {
  nodes: AppNode[];
  edges: AppEdge[];
  warnings: CoverageWarning[];
  /** Capability ids declared by this module's permissions. */
  capabilityIds: Set<string>;
}

/** Extract one module's manifest facts. `mod.manifest` null → empty extraction. */
export function extractHarmonyManifest(mod: HarmonyModule): HarmonyManifestExtraction {
  const ctx = new HarmonyManifestContext(`${mod.dir}/src/main/module.json5`, mod);
  const manifest = mod.manifest;
  if (!manifest) return ctx.result();

  for (const perm of manifest.requestPermissions) ctx.permission(perm.name, perm.reason);
  for (const ability of manifest.abilities) ctx.ability(manifest, ability, false);
  for (const ability of manifest.extensionAbilities) ctx.ability(manifest, ability, true);

  return ctx.result();
}

class HarmonyManifestContext {
  private readonly nodes: AppNode[] = [];
  private readonly edges: AppEdge[] = [];
  private readonly warnings: CoverageWarning[] = [];
  private readonly seen = new Set<string>();
  readonly capabilityIds = new Set<string>();

  constructor(
    private readonly file: string,
    private readonly mod: HarmonyModule
  ) {}

  result(): HarmonyManifestExtraction {
    return {
      nodes: this.nodes.sort((a, b) => a.id.localeCompare(b.id)),
      edges: this.edges.sort((a, b) => a.id.localeCompare(b.id)),
      warnings: this.warnings,
      capabilityIds: this.capabilityIds,
    };
  }

  private ref(symbol?: string) {
    return { file: this.file, symbol };
  }

  private addNode(node: AppNode): AppNode {
    if (!this.seen.has(node.id)) {
      this.seen.add(node.id);
      this.nodes.push(node);
    }
    return node;
  }

  private addEdge(edge: AppEdge): void {
    if (!this.seen.has(edge.id)) {
      this.seen.add(edge.id);
      this.edges.push(edge);
    }
  }

  // --- Permissions & capabilities -----------------------------------------

  permission(name: string, reason?: string): void {
    const matchKey = permissionMatchKey(name);
    this.addNode({
      id: makeNodeId('harmony', 'Permission', matchKey),
      kind: 'Permission',
      matchKey,
      name,
      platform: 'harmony',
      platformRef: this.ref(name),
      provenance: 'manifest',
      fidelity: 'source-project',
      confidence: 1,
      attrs: { module: this.mod.name, ...(reason ? { reason } : {}) },
    });

    const capId = harmonyPermissionToCapability(name);
    if (!capId) {
      this.warnings.push({
        message:
          `权限 ${name}(模块 ${this.mod.name})未映射到能力词表——` +
          `跨平台能力对齐会缺这一项,不代表该应用没有此能力`,
        ref: this.ref(name),
      });
      return;
    }
    this.capability(capId);
  }

  private capability(capId: string): AppNode {
    if (!isCapabilityId(capId)) throw new Error(`未知能力 id: ${capId}`);
    const matchKey = capabilityMatchKey(capId);
    this.capabilityIds.add(capId);
    return this.addNode({
      id: makeNodeId('harmony', 'Capability', matchKey),
      kind: 'Capability',
      matchKey,
      name: capId,
      platform: 'harmony',
      provenance: 'manifest',
      fidelity: 'source-project',
      confidence: 1,
      attrs: { module: this.mod.name },
    });
  }

  // --- Abilities ------------------------------------------------------------

  ability(manifest: ModuleManifest, ability: HarmonyAbility, isExtension: boolean): void {
    const isEntry = !isExtension && manifest.mainElement === ability.name;
    const launcher = ability.skills.some(isLauncherSkill);

    const node = isEntry || launcher ? this.appEntry(ability) : this.backgroundComponent(ability, isExtension);

    for (const skill of ability.skills) {
      for (const uri of skill.uris) this.deepLink(node, skill, uri, ability);
    }
  }

  private appEntry(ability: HarmonyAbility): AppNode {
    const matchKey = componentMatchKey(ability.name);
    return this.addNode({
      id: makeNodeId('harmony', 'AppEntry', matchKey),
      kind: 'AppEntry',
      matchKey,
      name: ability.name,
      platform: 'harmony',
      subtype: 'ability',
      platformRef: { file: this.srcEntryPath(ability) ?? this.file, symbol: ability.name },
      provenance: 'manifest',
      fidelity: 'source-project',
      confidence: 1,
      attrs: {
        module: this.mod.name,
        exported: ability.exported,
        ...(ability.srcEntry ? { srcEntry: this.srcEntryPath(ability) } : {}),
      },
    });
  }

  private backgroundComponent(ability: HarmonyAbility, isExtension: boolean): AppNode {
    const matchKey = componentMatchKey(ability.name);
    // `form` (home-screen widget) and `backup` dominate real projects; a plain
    // non-entry UIAbility is recorded as `ability`.
    const subtype = isExtension ? (ability.extensionType ?? 'extension') : 'ability';
    return this.addNode({
      id: makeNodeId('harmony', 'BackgroundComponent', matchKey),
      kind: 'BackgroundComponent',
      matchKey,
      name: ability.name,
      platform: 'harmony',
      subtype,
      platformRef: { file: this.srcEntryPath(ability) ?? this.file, symbol: ability.name },
      provenance: 'manifest',
      fidelity: 'source-project',
      confidence: 1,
      attrs: {
        module: this.mod.name,
        exported: ability.exported,
        ...(ability.srcEntry ? { srcEntry: this.srcEntryPath(ability) } : {}),
      },
    });
  }

  /** `./ets/entryability/EntryAbility.ets` → `<moduleDir>/src/main/ets/…`. */
  private srcEntryPath(ability: HarmonyAbility): string | undefined {
    if (!ability.srcEntry) return undefined;
    const rel = ability.srcEntry.replace(/^\.\//, '');
    return `${this.mod.dir}/src/main/${rel}`;
  }

  // --- Deep links -----------------------------------------------------------

  private deepLink(
    owner: AppNode,
    skill: HarmonySkill,
    uri: HarmonyUri,
    ability: HarmonyAbility
  ): void {
    const scheme = uri.scheme;
    if (!scheme) return; // a host/path with no scheme is not addressable

    const path = uri.path ?? uri.pathStartWith ?? uri.pathRegex;
    const matchKey = resourceMatchKey(scheme, uri.host, path);
    const display = `${scheme}://${uri.host ?? ''}${path ? `/${path}` : ''}`;

    const resource = this.addNode({
      id: makeNodeId('harmony', 'Resource', matchKey),
      kind: 'Resource',
      matchKey,
      name: display,
      platform: 'harmony',
      subtype: 'deep-link',
      platformRef: this.ref(ability.name),
      provenance: 'manifest',
      fidelity: 'source-project',
      confidence: 1,
      attrs: {
        module: this.mod.name,
        scheme,
        ...(uri.host ? { host: uri.host } : {}),
        ...(path ? { path } : {}),
        ...(uri.pathRegex ? { pathRegex: uri.pathRegex } : {}),
        // ≈ android:autoVerify — App Linking requires proven domain ownership.
        ...(skill.domainVerify ? { domainVerify: true } : {}),
        ...(skill.actions.includes(ACTION_VIEW_DATA) ? { viewData: true } : {}),
      },
    });

    this.addEdge({
      id: makeEdgeId('exposes', owner.id, resource.id),
      kind: 'exposes',
      from: owner.id,
      to: resource.id,
      provenance: 'manifest',
      confidence: 1,
    });
  }
}

/** `entity.system.home` (+ the home action) marks the launcher ability. */
function isLauncherSkill(skill: HarmonySkill): boolean {
  return skill.entities.includes(ENTITY_HOME) || skill.actions.includes(ACTION_HOME);
}
