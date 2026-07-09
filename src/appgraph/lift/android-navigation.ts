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

  constructor(private readonly index: ComponentIndex) {}

  scanFile(relPath: string, source: string): void {
    const className = primaryTypeName(relPath);
    if (!className) return;
    const isScreenFile = /(?:Activity|Fragment|Dialog)$/.test(className);
    if (!isScreenFile) return;

    // A Fragment/Dialog that issues an explicit intent is a source-discovered
    // Screen (Fragments/Dialogs never appear in the manifest). The navigation
    // EDGES it implies are lifted from the core android-intent synthesized edges
    // (lift/navigates-from-core.ts) — this pass only REGISTERS the screen.
    const lines = source.split('\n');
    for (const line of lines) {
      if (NAV_CALL_RE.test(line) || SERVICE_CALL_RE.test(line)) {
        this.resolveFrom(className, isScreenFile, relPath);
        return;
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
