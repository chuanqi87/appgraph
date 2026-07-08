/**
 * M4 · parse generated ArkTS back into a target AppGraph.
 *
 * ArkTS has no mature public grammar (and `@Component struct X` isn't valid TS),
 * so — exactly as the plan scopes it — the target side is recovered by focused
 * regex, reusing appgraph's `scanArktsPage` for @Entry pages. Capability presence
 * is detected by scanning for each capability's HarmonyOS API markers (the
 * `@ohos.*`/`@kit.*`/`@Component`… tokens from the capability→target table).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AppNode, makeNodeId } from '../schema';
import { scanArktsPage } from '../extractors/harmony/pages';
import { CAPABILITY_SPECS, CapabilitySpec } from '../capabilities-ext';

/** HarmonyOS API markers a capability's presence can be detected by. */
export function capabilityMarkers(spec: CapabilitySpec): string[] {
  const text = [spec.harmony.module, ...(spec.harmony.constructs ?? []).map((c) => c.to)].join(' ');
  const tokens = [...text.matchAll(/@[A-Za-z][\w.]*/g)].map((m) => m[0]);
  return [...new Set(tokens)];
}

/** Capabilities that CAN be verified (have at least one detectable marker). */
export const VERIFIABLE_SPECS: Array<{ spec: CapabilitySpec; markers: string[] }> = CAPABILITY_SPECS
  .map((spec) => ({ spec, markers: capabilityMarkers(spec) }))
  .filter((x) => x.markers.length > 0);

export interface TargetParse {
  /** Detected HarmonyOS Capability nodes (matchKey `capability:<id>`). */
  capabilityNodes: AppNode[];
  /** @Entry Screen nodes recovered from the generated pages. */
  screenNodes: AppNode[];
  /** Router navigation edges (from @Entry struct → routed page basename). */
  navEdges: Array<{ from: string; to: string }>;
  /** capability ids that could not be auto-verified (no marker). */
  unverifiable: string[];
  fileCount: number;
}

/** Walk the generated HarmonyOS output dir and recover the target AppGraph nodes. */
export function parseGeneratedTarget(generatedRoot: string): TargetParse {
  const files = walkEtsFiles(generatedRoot);
  const detected = new Set<string>();
  const screenById = new Map<string, AppNode>();
  const navEdgeKeys = new Set<string>();

  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const { spec, markers } of VERIFIABLE_SPECS) {
      if (markers.some((m) => source.includes(m))) detected.add(spec.id);
    }
    const page = scanArktsPage(file, source);
    if (page.screen) screenById.set(page.screen.id, page.screen);
    if (page.screen && page.navTargets.length > 0) {
      for (const to of page.navTargets) navEdgeKeys.add(`${page.screen.name}\0${to}`);
    }
  }

  const capabilityNodes: AppNode[] = [...detected].sort().map((id) => {
    const matchKey = `capability:${id}`;
    return {
      id: makeNodeId('harmony', 'Capability', matchKey),
      kind: 'Capability',
      matchKey,
      name: id,
      platform: 'harmony',
      provenance: 'source-static',
      fidelity: 'partial',
      confidence: 0.8,
    };
  });

  const verifiableIds = new Set(VERIFIABLE_SPECS.map((x) => x.spec.id));
  const unverifiable = CAPABILITY_SPECS.filter((s) => !verifiableIds.has(s.id)).map((s) => s.id);

  const navEdges = [...navEdgeKeys]
    .sort()
    .map((k) => {
      const [from, to] = k.split('\0');
      return { from: from!, to: to! };
    });

  return {
    capabilityNodes,
    screenNodes: [...screenById.values()].sort((a, b) => a.id.localeCompare(b.id)),
    navEdges,
    unverifiable,
    fileCount: files.length,
  };
}

function walkEtsFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ets')) out.push(full);
    }
  };
  walk(root);
  return out;
}
