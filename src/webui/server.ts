/**
 * Local HTTP server backing the knowledge-graph web UI. Serves the bundled
 * static client (dist/webui/static/, see scripts/build-webui.mjs) plus a
 * small JSON API over the existing CodeGraph query API and the AppGraph
 * document — see routes/codegraph-routes.ts and routes/appgraph-routes.ts.
 *
 * Read-only viewer: it never indexes or syncs on the caller's behalf (mirrors
 * `codegraph status`'s "report, don't act" behavior) — a project with no
 * `.codegraph/` index still starts the server, it just reports that state to
 * the client instead of every route erroring.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { CodeGraph } from '../index';
import { appGraphPath } from '../appgraph/paths';
import { migrationGraphPath } from '../migration/serialize';
import { getLedgerPath } from '../migration/paths';
import { Router } from './router';
import { registerCodeGraphRoutes } from './routes/codegraph-routes';
import { registerAppGraphRoutes } from './routes/appgraph-routes';
import { registerMigrationRoutes } from './routes/migration-routes';

export interface WebUiOptions {
  /** Preferred port. Falls back to an OS-assigned free port if taken. */
  port?: number;
  /** Bind address. Defaults to loopback only — this serves local project data. */
  host?: string;
  /** Auto-open the default browser once listening. Defaults to true. */
  open?: boolean;
  /** Which tab the client should land on. Defaults to 'codegraph'. */
  initialLayer?: 'codegraph' | 'appgraph' | 'migration';
}

export interface WebUiServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

const DEFAULT_PORT = 4317;
const STATIC_DIR = path.join(__dirname, 'static');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
};

export async function startWebUiServer(root: string, options: WebUiOptions = {}): Promise<WebUiServer> {
  const resolvedRoot = path.resolve(root);
  const host = options.host ?? '127.0.0.1';

  // Not-indexed is a state the UI reports, not a startup failure.
  let codeGraph: CodeGraph | null = null;
  if (CodeGraph.isInitialized(resolvedRoot)) {
    codeGraph = await CodeGraph.open(resolvedRoot);
  }
  const getCodeGraph = (): CodeGraph | null => codeGraph;

  const router = new Router();
  router.get('/api/status', () => ({
    body: {
      projectRoot: resolvedRoot,
      initialLayer: options.initialLayer ?? 'codegraph',
      codegraph: {
        indexed: codeGraph !== null,
        stats: codeGraph?.getStats() ?? null,
      },
      appgraph: {
        built: fs.existsSync(appGraphPath(resolvedRoot)),
      },
      migration: {
        built: fs.existsSync(migrationGraphPath(resolvedRoot)),
        ledger: fs.existsSync(getLedgerPath(resolvedRoot)),
      },
    },
  }));
  registerCodeGraphRoutes(router, getCodeGraph);
  registerAppGraphRoutes(router, resolvedRoot, getCodeGraph);
  registerMigrationRoutes(router, resolvedRoot);

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, router);
  });

  const port = await listen(server, host, options.port ?? DEFAULT_PORT);
  const url = `http://${host}:${port}/${options.initialLayer === 'appgraph' ? '#/appgraph' : options.initialLayer === 'migration' ? '#/migration' : ''}`;

  if (options.open !== false) {
    openBrowser(url);
  }

  return {
    url,
    port,
    close: () =>
      new Promise((resolve, reject) => {
        codeGraph?.close();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** Try `preferredPort` first; on EADDRINUSE, fall back to an OS-assigned free port. */
function listen(server: http.Server, host: string, preferredPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const attempt = (port: number, isFallback: boolean): void => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening);
        if (!isFallback && err.code === 'EADDRINUSE') {
          attempt(0, true);
        } else {
          reject(err);
        }
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : preferredPort);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    };
    attempt(preferredPort, false);
  });
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin'
      ? `open "${url}"`
      : process.platform === 'win32'
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  // Best-effort — the printed URL remains usable if this fails (headless CI,
  // no default browser configured, missing xdg-open on a minimal Linux box).
  exec(command, () => undefined);
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, router: Router): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://internal');
    const pathname = decodeURIComponent(url.pathname);

    if (pathname.startsWith('/api/')) {
      const result = await router.dispatch(req.method ?? 'GET', pathname, url.searchParams);
      if (!result) {
        sendJson(res, 404, { error: `No route for ${req.method} ${pathname}` });
        return;
      }
      sendJson(res, result.status ?? 200, result.body);
      return;
    }

    serveStatic(pathname, res);
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** Serves the bundled client. Hash routes (#/codegraph/nodes/:id, ...) never
 *  reach the server, so every non-API path other than known static files just
 *  serves index.html and the client's own hash router takes it from there. */
function serveStatic(pathname: string, res: http.ServerResponse): void {
  const relPath = pathname === '/' || !path.extname(pathname) ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(STATIC_DIR, relPath);
  const withinStatic = filePath === STATIC_DIR || filePath.startsWith(STATIC_DIR + path.sep);
  if (!withinStatic) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream' });
    res.end(data);
  });
}
