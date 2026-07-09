#!/usr/bin/env node
/**
 * Bundle the web UI's browser client (src/webui/client/) into
 * dist/webui/static/, alongside src/webui/server.ts's compiled output
 * (dist/webui/server.js), which serves that directory at runtime via
 * path.join(__dirname, 'static') — same convention as copy-assets placing
 * schema.sql/*.wasm next to their consuming compiled .js files.
 */

import { build } from 'esbuild';
import { mkdirSync, copyFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const clientDir = join(root, 'src/webui/client');
const outDir = join(root, 'dist/webui/static');

mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(clientDir, 'app.ts')],
  outfile: join(outDir, 'app.js'),
  bundle: true,
  minify: true,
  sourcemap: true,
  target: ['es2020'],
  format: 'iife',
  logLevel: 'info',
});

copyFileSync(join(clientDir, 'index.html'), join(outDir, 'index.html'));
copyFileSync(join(clientDir, 'styles.css'), join(outDir, 'styles.css'));
