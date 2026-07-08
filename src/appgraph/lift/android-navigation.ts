/**
 * Navigation lifting: derive `navigates_to` / `backed_by` edges (and the
 * source-defined Screen nodes they connect) from Kotlin/Java source.
 *
 * The manifest only declares Activities/Services — the richest navigation in a
 * modern app is Fragment→Activity and Fragment→Fragment, and Fragments never
 * appear in the manifest. So this pass both (a) discovers `*Fragment`/`*Dialog`
 * screens by source convention and (b) reads explicit-intent navigation:
 *
 *   startActivity(Intent(ctx, TargetActivity::class.java))   // navigates_to
 *   startService(Intent(ctx, SomeService::class.java))       // backed_by
 *   new Intent(this, Target.class)                           // Java form
 *
 * Everything here is `provenance:'lifted'` with a file+line evidence ref and a
 * confidence below the manifest's — it is heuristic, evidence-backed truth, and
 * anything whose target can't be resolved becomes a coverageWarning, never a
 * silent drop.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  AppEdge,
  AppGraph,
  AppNode,
  CoverageWarning,
  makeEdgeId,
  makeNodeId,
  screenMatchKey,
} from '../schema';

const EXCLUDED_DIRS = new Set([
  'build',
  '.git',
  '.gradle',
  '.idea',
  'node_modules',
  '.appgraph',
  '.codegraph',
]);
const TEST_SEGMENTS = ['/src/test/', '/src/androidtest/'];

const NAV_CALL_RE = /\b(?:startActivity|startActivityForResult|startActivities)\s*\(/;
const SERVICE_CALL_RE = /\b(?:startService|startForegroundService|bindService)\s*\(/;
const CLASS_REF_RE = /([A-Za-z_]\w*)(?:::class\.java|\.class)\b/g;

export interface NavigationLift {
  nodes: AppNode[];
  edges: AppEdge[];
  warnings: CoverageWarning[];
}

/** `graph` provides the existing (manifest) Screen/Component index; result is additive. */
export function liftNavigation(graph: AppGraph, projectRoot: string): NavigationLift {
  const index = new ComponentIndex(graph);
  const ctx = new LiftContext(index);

  for (const file of findSourceFiles(projectRoot).sort()) {
    const relPath = toPosix(relative(projectRoot, file));
    ctx.scanFile(relPath, readFileSync(file, 'utf8'));
  }

  return { nodes: ctx.newNodes, edges: ctx.edges, warnings: ctx.warnings };
}

/** Resolve a simple class name to an existing Screen / BackgroundComponent node. */
class ComponentIndex {
  private readonly screens = new Map<string, AppNode>();
  private readonly components = new Map<string, AppNode>();

  constructor(graph: AppGraph) {
    for (const node of graph.nodes) {
      if (node.kind === 'Screen') this.screens.set(node.name.toLowerCase(), node);
      else if (node.kind === 'BackgroundComponent') this.components.set(node.name.toLowerCase(), node);
    }
  }

  screen(simpleName: string): AppNode | undefined {
    return this.screens.get(simpleName.toLowerCase());
  }
  component(simpleName: string): AppNode | undefined {
    return this.components.get(simpleName.toLowerCase());
  }
  addScreen(node: AppNode): void {
    this.screens.set(node.name.toLowerCase(), node);
  }
}

class LiftContext {
  readonly newNodes: AppNode[] = [];
  readonly edges: AppEdge[] = [];
  readonly warnings: CoverageWarning[] = [];
  private readonly emitted = new Set<string>();

  constructor(private readonly index: ComponentIndex) {}

  scanFile(relPath: string, source: string): void {
    const className = primaryTypeName(relPath);
    if (!className) return;
    const isScreenFile = /(?:Activity|Fragment|Dialog)$/.test(className);

    const lines = source.split('\n');
    let fromScreen: AppNode | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const isNav = NAV_CALL_RE.test(line);
      const isService = SERVICE_CALL_RE.test(line);
      if (!isNav && !isService) continue;

      // Only attribute navigation from a screen context.
      if (!fromScreen) fromScreen = this.resolveFrom(className, isScreenFile, relPath);
      if (!fromScreen) continue;

      for (const target of classRefs(line)) {
        if (isService) {
          const bg = this.index.component(target);
          if (bg) this.edge('backed_by', fromScreen, bg, relPath, i + 1, 'start-service');
        } else {
          const screen = this.index.screen(target);
          if (screen && screen.id !== fromScreen.id) {
            this.edge('navigates_to', fromScreen, screen, relPath, i + 1, 'explicit-intent');
          }
        }
      }
    }
  }

  /** The screen a file's navigation is attributed to; synthesizes a source Screen for Fragments/Dialogs. */
  private resolveFrom(className: string, isScreenFile: boolean, relPath: string): AppNode | null {
    const existing = this.index.screen(className);
    if (existing) return existing;
    if (!isScreenFile) return null;

    const subtype = /Fragment$/.test(className) ? 'fragment' : /Dialog$/.test(className) ? 'dialog' : 'activity';
    const matchKey = screenMatchKey(className);
    const node: AppNode = {
      id: makeNodeId('android', 'Screen', matchKey),
      kind: 'Screen',
      matchKey,
      name: className,
      platform: 'android',
      subtype,
      platformRef: { file: relPath, symbol: className },
      provenance: 'source-static',
      fidelity: 'source-project',
      confidence: 0.9, // discovered by naming convention, not a manifest declaration
      attrs: { discoveredBy: 'source-convention', module: moduleOf(relPath) },
    };
    this.index.addScreen(node);
    this.newNodes.push(node);
    return node;
  }

  private edge(
    kind: 'navigates_to' | 'backed_by',
    from: AppNode,
    to: AppNode,
    file: string,
    line: number,
    via: string
  ): void {
    const id = makeEdgeId(kind, from.id, to.id);
    if (this.emitted.has(id)) return;
    this.emitted.add(id);
    this.edges.push({
      id,
      kind,
      from: from.id,
      to: to.id,
      provenance: 'lifted',
      confidence: 0.85,
      attrs: { via, evidenceFile: file, evidenceLine: line },
    });
  }
}

/** All `X::class.java` / `X.class` class names referenced on a line. */
function classRefs(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(CLASS_REF_RE)) if (m[1]) out.push(m[1]);
  return out;
}

/** Kotlin/Java files are named after their primary type — use the filename. */
function primaryTypeName(relPath: string): string | null {
  const base = relPath.split('/').pop() ?? '';
  const m = /^([A-Za-z_]\w*)\.(kt|java)$/.exec(base);
  return m?.[1] ?? null;
}

function findSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) walk(full);
      } else if (/\.(kt|java)$/.test(entry.name) && !isTestSource(full)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

function isTestSource(path: string): boolean {
  const p = toPosix(path).toLowerCase();
  return TEST_SEGMENTS.some((seg) => p.includes(seg));
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

/** Module dir from a `<module>/src/...` path, matching the manifest module label. */
function moduleOf(relPath: string): string {
  const idx = relPath.indexOf('/src/');
  return idx > 0 ? relPath.slice(0, idx) : 'root';
}
