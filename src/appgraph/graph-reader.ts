/**
 * Read-side adapter over an already-indexed `codegraph.db`.
 *
 * The migration layer never writes to the code-symbol graph — it only reads
 * nodes and edges out of it to lift the higher-level module/community/capability
 * structure. This wraps the exported `DatabaseConnection` + `QueryBuilder` so the
 * rest of the migration code depends on a small, migration-shaped surface rather
 * than on codegraph internals.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseConnection, getDatabasePath } from '../db';
import { QueryBuilder } from '../db/queries';
import { isInitialized } from '../directory';
import { EdgeKind, Node } from '../types';

/** A code-symbol edge, projected to the three fields the migration lift needs. */
export interface CodeEdge {
  source: string;
  target: string;
  kind: EdgeKind;
}

export class CodeSymbolGraph {
  private constructor(
    private readonly db: DatabaseConnection,
    private readonly queries: QueryBuilder,
    readonly projectRoot: string
  ) {}

  /** Open the code-symbol graph for an indexed project (throws if not indexed). */
  static open(projectRoot: string): CodeSymbolGraph {
    if (!isInitialized(projectRoot)) {
      throw new Error(
        `源工程尚未建立 codegraph 索引:${projectRoot}\n先运行 “migrate index <projectRoot>” 建库。`
      );
    }
    const db = DatabaseConnection.open(getDatabasePath(projectRoot));
    return new CodeSymbolGraph(db, new QueryBuilder(db.getDb()), projectRoot);
  }

  /** Every code symbol in the graph. */
  getAllNodes(): Node[] {
    return this.queries.getAllNodes();
  }

  /**
   * Every edge in the graph. `QueryBuilder` has no `getAllEdges()`, so read the
   * `edges` table directly (source/target/kind is all the module + community
   * lift consumes; metadata/line/provenance are irrelevant to the projection).
   */
  getAllEdges(): CodeEdge[] {
    const rows = this.db
      .getDb()
      .prepare('SELECT source, target, kind FROM edges')
      .all() as Array<{ source: string; target: string; kind: string }>;
    return rows.map((r) => ({ source: r.source, target: r.target, kind: r.kind as EdgeKind }));
  }

  /** The underlying prepared-statement layer, for stages that need richer reads. */
  queryBuilder(): QueryBuilder {
    return this.queries;
  }

  /**
   * Source text for a node, read from disk by its line span. Returns null if the
   * file is unreadable. Used to assemble per-module migration context (M3).
   */
  getCode(node: Node): string | null {
    let content: string;
    try {
      content = readFileSync(join(this.projectRoot, node.filePath), 'utf8');
    } catch {
      return null;
    }
    const lines = content.split('\n');
    const start = Math.max(0, node.startLine - 1);
    const end = Math.min(lines.length, node.endLine);
    return lines.slice(start, end).join('\n');
  }

  close(): void {
    this.db.close();
  }
}
