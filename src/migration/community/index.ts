/**
 * M2 · synthesis — turn detected communities into the advisory Feature overlay.
 *
 * The main migration unit stays the ArchModule (M1); Features refine it:
 *   - a single-module community where its module split into several is a
 *     `subdivision` (e.g. the monolithic `app` broken into functional clusters);
 *   - a single-module community that is the whole module is `aligned`;
 *   - a community spanning >1 module is a `cross-module` advisory grouping.
 *
 * Feature nodes are DETERMINISTIC (membership fingerprint = matchKey), which is
 * what separates them from appgraph's LLM-labelled Feature. The human-readable
 * hub name is advisory and never participates in identity.
 */

import {
  AppEdge,
  AppNode,
  CoverageWarning,
  makeEdgeId,
  makeNodeId,
} from '../schema';
import { CodeSymbolGraph } from '../graph-reader';
import { assignNodesToModules } from '../modules/assign';
import { liftedConfidence } from '../modules/aggregate';
import { Community, detectCommunities } from './detect';
import { projectFileCoupling } from './project';

export interface CommunityResult {
  nodes: AppNode[];
  edges: AppEdge[];
  warnings: CoverageWarning[];
  communities: Community[];
  stats: {
    featureCount: number;
    subdivision: number;
    crossModule: number;
    aligned: number;
    coupledFiles: number;
  };
}

/**
 * Detect functional communities and synthesize the Feature overlay.
 *
 * @param archModules  ArchModule nodes from the persisted M1 graph (need attrs.dir)
 * @param reader       the open code-symbol graph
 */
export function buildCommunityOverlay(
  archModules: AppNode[],
  reader: CodeSymbolGraph
): CommunityResult {
  const moduleDirToId = new Map<string, string>();
  const moduleDirs: string[] = [];
  for (const m of archModules) {
    const dir = typeof m.attrs?.dir === 'string' ? m.attrs.dir : undefined;
    if (dir !== undefined) {
      moduleDirToId.set(dir, m.id);
      moduleDirs.push(dir);
    }
  }

  const nodes = reader.getAllNodes();
  const edges = reader.getAllEdges();
  const assignment = assignNodesToModules(nodes, moduleDirs);
  const projection = projectFileCoupling(nodes, edges, assignment.fileToModuleDir);
  const communities = detectCommunities(projection.graph);

  // file → community index (for orienting Feature→Feature edges).
  const fileToCommunity = new Map<string, number>();
  for (const c of communities) for (const f of c.members) fileToCommunity.set(f, c.id);

  // How many communities each module is split across (drives subdivision vs aligned).
  const communitiesPerModule = new Map<string, Set<number>>();
  for (const c of communities) {
    for (const f of c.members) {
      const dir = projection.fileToModuleDir.get(f);
      if (dir === undefined) continue;
      let s = communitiesPerModule.get(dir);
      if (!s) {
        s = new Set<number>();
        communitiesPerModule.set(dir, s);
      }
      s.add(c.id);
    }
  }

  const featureNodes: AppNode[] = [];
  const featureIdByCommunity = new Map<number, string>();
  const featureEdges: AppEdge[] = [];
  let subdivision = 0;
  let crossModule = 0;
  let aligned = 0;

  for (const c of communities) {
    // module span + per-module file counts.
    const fileCountByModuleId = new Map<string, number>();
    for (const f of c.members) {
      const dir = projection.fileToModuleDir.get(f);
      const moduleId = dir !== undefined ? moduleDirToId.get(dir) : undefined;
      if (moduleId === undefined) continue;
      fileCountByModuleId.set(moduleId, (fileCountByModuleId.get(moduleId) ?? 0) + 1);
    }
    const moduleSpan = [...fileCountByModuleId.keys()].sort();

    let role: 'subdivision' | 'aligned' | 'cross-module';
    if (moduleSpan.length > 1) {
      role = 'cross-module';
      crossModule++;
    } else if (moduleSpan.length === 1) {
      const dir = firstDirForModule(moduleSpan[0]!, moduleDirToId);
      const split = dir !== undefined && (communitiesPerModule.get(dir)?.size ?? 0) > 1;
      role = split ? 'subdivision' : 'aligned';
      if (split) subdivision++;
      else aligned++;
    } else {
      // No owning module (shouldn't happen — coupled files are always assigned).
      role = 'aligned';
      aligned++;
    }

    const matchKey = `feature:${c.sig}`;
    const id = makeNodeId('android', 'Feature', matchKey);
    featureIdByCommunity.set(c.id, id);
    featureNodes.push({
      id,
      kind: 'Feature',
      matchKey,
      name: c.hubName,
      platform: 'android',
      subtype: role,
      provenance: 'lifted',
      fidelity: 'source-project',
      confidence: cohesionConfidence(c.cohesion),
      attrs: {
        size: c.members.length,
        cohesion: round(c.cohesion),
        hub: c.hubName,
        role,
        sig: c.sig,
        moduleSpan,
        members: c.members,
      },
    });

    // ArchModule → Feature (this module contains this cluster).
    for (const [moduleId, fileCount] of fileCountByModuleId) {
      featureEdges.push({
        id: makeEdgeId('app_contains', moduleId, id),
        kind: 'app_contains',
        from: moduleId,
        to: id,
        provenance: 'lifted',
        confidence: 0.7,
        attrs: { fileCount },
      });
    }
  }

  // Feature → Feature depends_on from directed cross-community coupling.
  const pairWeight = new Map<string, number>();
  for (const [key, n] of projection.directed) {
    const sep = key.indexOf('\0');
    const ca = fileToCommunity.get(key.slice(0, sep));
    const cb = fileToCommunity.get(key.slice(sep + 1));
    if (ca === undefined || cb === undefined || ca === cb) continue;
    pairWeight.set(`${ca}\0${cb}`, (pairWeight.get(`${ca}\0${cb}`) ?? 0) + n);
  }
  for (const [key, weight] of pairWeight) {
    const sep = key.indexOf('\0');
    const from = featureIdByCommunity.get(Number(key.slice(0, sep)));
    const to = featureIdByCommunity.get(Number(key.slice(sep + 1)));
    if (from === undefined || to === undefined) continue;
    featureEdges.push({
      id: makeEdgeId('depends_on', from, to),
      kind: 'depends_on',
      from,
      to,
      provenance: 'lifted',
      confidence: liftedConfidence(weight),
      attrs: { weight, scope: 'feature' },
    });
  }

  return {
    nodes: featureNodes,
    edges: featureEdges.sort((a, b) => a.id.localeCompare(b.id)),
    warnings: [],
    communities,
    stats: {
      featureCount: featureNodes.length,
      subdivision,
      crossModule,
      aligned,
      coupledFiles: projection.graph.order,
    },
  };
}

function firstDirForModule(moduleId: string, moduleDirToId: Map<string, string>): string | undefined {
  for (const [dir, id] of moduleDirToId) if (id === moduleId) return dir;
  return undefined;
}

/** Confidence tiers from a community's intra-edge density. */
function cohesionConfidence(cohesion: number): number {
  if (cohesion >= 0.3) return 0.8;
  if (cohesion >= 0.1) return 0.6;
  return 0.4;
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
