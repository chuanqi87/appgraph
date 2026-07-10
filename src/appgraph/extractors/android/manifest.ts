/**
 * Deterministic AndroidManifest.xml → AppGraph extractor (structural truth).
 *
 * Emits Screen / BackgroundComponent / AppEntry / Permission / Capability /
 * Resource nodes and the edges provable from the manifest alone. Anything the
 * manifest cannot attribute (e.g. which screen actually uses an app-level
 * permission) is left for the later source-lifting pass and surfaced as a
 * coverageWarning rather than guessed.
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
  screenMatchKey,
} from '../../schema';
import { androidPermissionToCapability } from './capabilities';
import { XmlElement, childrenNamed, parseXml, walk } from './xml';

const ACTION_MAIN = 'android.intent.action.MAIN';
const CATEGORY_LAUNCHER = 'android.intent.category.LAUNCHER';
const ACTION_VIEW = 'android.intent.action.VIEW';
const CATEGORY_BROWSABLE = 'android.intent.category.BROWSABLE';
const ACTION_VPN = 'android.net.VpnService';

export interface ManifestExtraction {
  packageName: string | null;
  nodes: AppNode[];
  edges: AppEdge[];
  warnings: CoverageWarning[];
}

/** `moduleLabel` (e.g. "core", "mobile") is recorded on every node for provenance. */
export function extractManifest(
  filePath: string,
  source: string,
  moduleLabel: string
): ManifestExtraction {
  const root = parseXml(source);
  if (!root || root.tag !== 'manifest') {
    return { packageName: null, nodes: [], edges: [], warnings: [] };
  }

  const ctx = new ManifestContext(filePath, moduleLabel);
  const packageName = root.attrs['package'] ?? null;

  ctx.collectAppPermissions(root);

  const application = childrenNamed(root, 'application')[0];
  if (application) {
    for (const el of application.children) ctx.handleComponent(el, packageName);
  }

  return { packageName, nodes: ctx.nodes, edges: ctx.edges, warnings: ctx.warnings };
}

class ManifestContext {
  readonly nodes: AppNode[] = [];
  readonly edges: AppEdge[] = [];
  readonly warnings: CoverageWarning[] = [];
  private readonly seen = new Set<string>();

  constructor(private readonly file: string, private readonly moduleLabel: string) {}

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

  /** App-scoped `<uses-permission>` → Permission + Capability nodes. */
  collectAppPermissions(root: XmlElement): void {
    walk(root, (el) => {
      if (el.tag !== 'uses-permission' && el.tag !== 'uses-permission-sdk-23') return;
      const name = el.attrs['android:name'];
      if (name) this.permissionNode(name);
    });
  }

  private permissionNode(permission: string): AppNode {
    const matchKey = permissionMatchKey(permission);
    const id = makeNodeId('android', 'Permission', matchKey);
    const node = this.addNode({
      id,
      kind: 'Permission',
      matchKey,
      name: permission,
      platform: 'android',
      platformRef: this.ref(permission),
      provenance: 'manifest',
      fidelity: 'source-project',
      confidence: 1,
      attrs: { module: this.moduleLabel },
    });
    this.capabilityFor(permission);
    return node;
  }

  /** Map a permission to a Capability node, or warn if unmapped. Returns the id. */
  private capabilityFor(permission: string): string | null {
    const cap = androidPermissionToCapability(permission);
    if (!cap) {
      this.warnings.push({
        message: `权限 ${permission} 未在能力映射表中，未归一化为 capability（图谱能力集可能不完整）`,
        ref: this.ref(permission),
      });
      return null;
    }
    const matchKey = capabilityMatchKey(cap);
    const id = makeNodeId('android', 'Capability', matchKey);
    this.addNode({
      id,
      kind: 'Capability',
      matchKey,
      name: cap,
      platform: 'android',
      provenance: 'manifest',
      fidelity: 'source-project',
      confidence: 1,
      attrs: { derivedFrom: permission },
    });
    return id;
  }

  // --- Components ----------------------------------------------------------

  handleComponent(el: XmlElement, packageName: string | null): void {
    const kindMap: Record<string, 'Screen' | 'BackgroundComponent'> = {
      activity: 'Screen',
      'activity-alias': 'Screen',
      service: 'BackgroundComponent',
      receiver: 'BackgroundComponent',
      provider: 'BackgroundComponent',
    };
    const appNodeKind = kindMap[el.tag];
    if (!appNodeKind) return;

    const rawName = el.attrs['android:name'];
    if (!rawName) return;
    const fqName = resolveClassName(rawName, packageName);
    const simpleName = fqName.split('.').pop() ?? fqName;
    const subtype = el.tag === 'activity-alias' ? 'activity' : el.tag;

    const matchKey =
      appNodeKind === 'Screen' ? screenMatchKey(simpleName) : componentMatchKey(simpleName);
    const id = makeNodeId('android', appNodeKind, matchKey);
    this.addNode({
      id,
      kind: appNodeKind,
      matchKey,
      name: simpleName,
      platform: 'android',
      subtype,
      platformRef: this.ref(fqName),
      provenance: 'manifest',
      fidelity: 'source-project',
      confidence: 1,
      attrs: {
        module: this.moduleLabel,
        exported: parseBool(el.attrs['android:exported']),
        foregroundServiceType: el.attrs['android:foregroundServiceType'],
      },
    });

    // Component-declared permission → requires_permission edge (evidence-backed).
    const requiredPermission = el.attrs['android:permission'];
    if (requiredPermission) {
      const permNode = this.permissionNode(requiredPermission);
      this.addEdge({
        id: makeEdgeId('requires_permission', id, permNode.id),
        kind: 'requires_permission',
        from: id,
        to: permNode.id,
        provenance: 'manifest',
        confidence: 1,
      });
    }

    this.handleIntentFilters(el, id, appNodeKind, requiredPermission);
  }

  private handleIntentFilters(
    el: XmlElement,
    nodeId: string,
    appNodeKind: 'Screen' | 'BackgroundComponent',
    requiredPermission: string | undefined
  ): void {
    const filters = childrenNamed(el, 'intent-filter');
    let isLauncher = false;
    let isVpn = requiredPermission === 'android.permission.BIND_VPN_SERVICE';

    for (const filter of filters) {
      const actions = childrenNamed(filter, 'action').map((a) => a.attrs['android:name']);
      const categories = childrenNamed(filter, 'category').map((c) => c.attrs['android:name']);

      if (actions.includes(ACTION_MAIN) && categories.includes(CATEGORY_LAUNCHER)) isLauncher = true;
      if (actions.includes(ACTION_VPN)) isVpn = true;

      // Deep link: VIEW + BROWSABLE + <data>. The `<data>` attributes of one
      // intent-filter MERGE (Android matches the cross-product), so aggregate the
      // whole filter — scheme × host × path — rather than reading one element.
      if (actions.includes(ACTION_VIEW) && categories.includes(CATEGORY_BROWSABLE)) {
        this.exposeDeepLinks(nodeId, filter);
      }
    }

    if (isLauncher && appNodeKind === 'Screen') this.appEntry(nodeId, el.attrs['android:name']);
    if (isVpn) this.usesCapability(nodeId, 'vpn', 'android.permission.BIND_VPN_SERVICE');
  }

  private appEntry(screenId: string, rawName: string | undefined): void {
    const simpleName = (rawName ?? '').split('.').pop() ?? 'main';
    const matchKey = `appentry:${screenId.slice(0, 8)}`;
    const id = makeNodeId('android', 'AppEntry', matchKey);
    this.addNode({
      id,
      kind: 'AppEntry',
      matchKey,
      name: simpleName,
      platform: 'android',
      subtype: 'launcher-activity',
      provenance: 'manifest',
      fidelity: 'source-project',
      confidence: 1,
      attrs: { module: this.moduleLabel, screen: screenId },
    });
  }

  /** `<data>` path-spec attributes, in Android precedence order. */
  private static readonly PATH_ATTRS: ReadonlyArray<[string, string]> = [
    ['android:path', 'path'],
    ['android:pathPrefix', 'pathPrefix'],
    ['android:pathPattern', 'pathPattern'],
    ['android:pathSuffix', 'pathSuffix'],
    ['android:pathAdvancedPattern', 'pathAdvancedPattern'],
  ];

  /**
   * Aggregate one intent-filter's `<data>` elements into structured deep links.
   * Android merges the filter's `<data>` attributes (matching the cross-product
   * of schemes × hosts × paths), so a split `<data scheme>…<data host>…<data
   * pathPrefix>` and a combined single `<data scheme host pathPrefix>` yield the
   * same links. A filter with no scheme cannot form a resolvable URI → skipped.
   */
  private exposeDeepLinks(fromId: string, filter: XmlElement): void {
    const schemes = new Set<string>();
    const hosts = new Set<string>();
    const paths: Array<{ type: string; value: string }> = [];
    const mimeTypes = new Set<string>();
    for (const data of childrenNamed(filter, 'data')) {
      const scheme = data.attrs['android:scheme'];
      if (scheme) schemes.add(scheme);
      const host = data.attrs['android:host'];
      if (host) hosts.add(host);
      for (const [attr, type] of ManifestContext.PATH_ATTRS) {
        const value = data.attrs[attr];
        if (value) paths.push({ type, value });
      }
      const mime = data.attrs['android:mimeType'];
      if (mime) mimeTypes.add(mime);
    }
    if (schemes.size === 0) return;

    const hostList: Array<string | undefined> = hosts.size > 0 ? [...hosts].sort() : [undefined];
    const pathList: Array<{ type: string; value: string } | undefined> =
      paths.length > 0
        ? [...paths].sort((a, b) => `${a.value}\0${a.type}`.localeCompare(`${b.value}\0${b.type}`))
        : [undefined];
    const mimes = [...mimeTypes].sort();
    for (const scheme of [...schemes].sort()) {
      for (const host of hostList) {
        for (const path of pathList) {
          this.exposeResource(fromId, scheme, host, path, mimes);
        }
      }
    }
  }

  private exposeResource(
    fromId: string,
    scheme: string,
    host?: string,
    path?: { type: string; value: string },
    mimeTypes: string[] = []
  ): void {
    const matchKey = resourceMatchKey(scheme, host, path?.value);
    const id = makeNodeId('android', 'Resource', matchKey);
    this.addNode({
      id,
      kind: 'Resource',
      matchKey,
      name: `${scheme}://${host ?? ''}${path?.value ?? ''}`,
      platform: 'android',
      subtype: 'deeplink',
      provenance: 'manifest',
      fidelity: 'source-project',
      confidence: 1,
      attrs: {
        scheme,
        ...(host ? { host } : {}),
        ...(path ? { path: path.value, pathType: path.type } : {}),
        ...(mimeTypes.length > 0 ? { mimeTypes } : {}),
      },
    });
    this.addEdge({
      id: makeEdgeId('exposes', fromId, id),
      kind: 'exposes',
      from: fromId,
      to: id,
      provenance: 'manifest',
      confidence: 1,
    });
  }

  private usesCapability(fromId: string, cap: 'vpn', evidence: string): void {
    const capId = this.capabilityFor(evidence) ?? this.capabilityFromId(cap, evidence);
    if (!capId) return;
    this.addEdge({
      id: makeEdgeId('uses_capability', fromId, capId),
      kind: 'uses_capability',
      from: fromId,
      to: capId,
      provenance: 'manifest',
      confidence: 1,
      attrs: { evidence },
    });
  }

  /** Ensure a Capability node exists directly from its id (for non-permission evidence). */
  private capabilityFromId(cap: string, evidence: string): string {
    const matchKey = capabilityMatchKey(cap as never);
    const id = makeNodeId('android', 'Capability', matchKey);
    this.addNode({
      id,
      kind: 'Capability',
      matchKey,
      name: cap,
      platform: 'android',
      provenance: 'manifest',
      fidelity: 'source-project',
      confidence: 1,
      attrs: { derivedFrom: evidence },
    });
    return id;
  }
}

/** Resolve a manifest `android:name` (possibly relative) to a fully-qualified class name. */
function resolveClassName(name: string, packageName: string | null): string {
  if (name.startsWith('.')) return packageName ? `${packageName}${name}` : name.slice(1);
  if (!name.includes('.')) return packageName ? `${packageName}.${name}` : name;
  return name;
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value === 'true';
}
