/**
 * Cross-platform AppGraph diff — the migration ground-truth check.
 *
 * Alignment is done ONLY on cross-platform-stable match keys: `Capability`
 * (controlled vocabulary) and `Resource` (scheme/host). These are identical
 * across Android/HarmonyOS/iOS by construction, so a missing one is a real,
 * deterministic migration gap. Screens/modules/permissions are platform-scoped
 * and reported as advisory counts only — never matched 1:1 (page names don't
 * survive a platform migration; capability coverage is the truth).
 */

import { AppGraph, AppNode, AppNodeKind } from '../schema';

export interface SetDiff {
  matched: string[];
  missingInTarget: string[]; // present in source, absent in target — the migration gaps
  extraInTarget: string[]; // present in target only (new/unmapped)
}

export interface MigrationGap {
  kind: 'capability' | 'resource';
  id: string;
  /** Missing capabilities that gate a whole feature area are high severity. */
  severity: 'high' | 'medium';
  detail: string;
}

export interface MigrationCoverageReport {
  source: { platform: string; packageName: string };
  target: { platform: string; packageName: string };
  capabilities: SetDiff;
  resources: SetDiff;
  screens: { source: number; target: number };
  backgroundComponents: { source: number; target: number };
  /** matched / (matched + missing), rounded to 2 decimals. 1 when nothing to migrate. */
  capabilityCoverage: number;
  gaps: MigrationGap[];
}

// Capabilities whose absence typically breaks a core user-facing feature.
const HIGH_SEVERITY = new Set([
  'vpn',
  'camera',
  'microphone',
  'location.fine',
  'location.background',
  'phone.call',
  'sms.send',
  'bluetooth',
  'nfc',
]);

export function compareAppGraphs(source: AppGraph, target: AppGraph): MigrationCoverageReport {
  const capabilities = diffMatchKeys(source, target, 'Capability');
  const resources = diffMatchKeys(source, target, 'Resource');

  const gaps: MigrationGap[] = [];
  for (const id of capabilities.missingInTarget) {
    gaps.push({
      kind: 'capability',
      id,
      severity: HIGH_SEVERITY.has(id) ? 'high' : 'medium',
      detail: `源应用具备能力 ${id}，目标应用未发现对应能力`,
    });
  }
  for (const id of resources.missingInTarget) {
    gaps.push({
      kind: 'resource',
      id,
      severity: 'medium',
      detail: `源应用对外暴露 ${id}，目标应用未发现`,
    });
  }
  gaps.sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity) || a.id.localeCompare(b.id)
  );

  const matched = capabilities.matched.length;
  const denom = matched + capabilities.missingInTarget.length;
  const capabilityCoverage = denom === 0 ? 1 : round2(matched / denom);

  return {
    source: { platform: source.platform, packageName: source.app.packageName },
    target: { platform: target.platform, packageName: target.app.packageName },
    capabilities,
    resources,
    screens: {
      source: countKind(source, 'Screen'),
      target: countKind(target, 'Screen'),
    },
    backgroundComponents: {
      source: countKind(source, 'BackgroundComponent'),
      target: countKind(target, 'BackgroundComponent'),
    },
    capabilityCoverage,
    gaps,
  };
}

/** Diff the set of match keys for one node kind, keyed by the cross-platform id. */
function diffMatchKeys(source: AppGraph, target: AppGraph, kind: AppNodeKind): SetDiff {
  const srcKeys = keySet(source, kind);
  const tgtKeys = keySet(target, kind);
  const matched: string[] = [];
  const missingInTarget: string[] = [];
  for (const k of srcKeys) (tgtKeys.has(k) ? matched : missingInTarget).push(k);
  const extraInTarget = [...tgtKeys].filter((k) => !srcKeys.has(k));
  return {
    matched: matched.map(idOf).sort(),
    missingInTarget: missingInTarget.map(idOf).sort(),
    extraInTarget: extraInTarget.map(idOf).sort(),
  };
}

function keySet(graph: AppGraph, kind: AppNodeKind): Set<string> {
  return new Set(graph.nodes.filter((n) => n.kind === kind).map((n) => n.matchKey));
}

/** `capability:camera` → `camera`, `resource:ss` → `ss`. */
function idOf(matchKey: string): string {
  const idx = matchKey.indexOf(':');
  return idx >= 0 ? matchKey.slice(idx + 1) : matchKey;
}

function countKind(graph: AppGraph, kind: AppNodeKind): number {
  return graph.nodes.filter((n: AppNode) => n.kind === kind).length;
}

function severityRank(s: 'high' | 'medium'): number {
  return s === 'high' ? 2 : 1;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
