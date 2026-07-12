#!/usr/bin/env node
/**
 * Bundle the web UI's browser client (src/webui/client/) into
 * dist/webui/static/, alongside src/webui/server.ts's compiled output
 * (dist/webui/server.js), which serves that directory at runtime via
 * path.join(__dirname, 'static') — same convention as copy-assets placing
 * schema.sql/*.wasm next to their consuming compiled .js files.
 */

import { build } from 'esbuild';
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const clientDir = join(root, 'src/webui/client');
const outDir = join(root, 'dist/webui/static');

mkdirSync(outDir, { recursive: true });

// 1. Compile Tailwind CSS → styles.css
const tailwindInput = join(clientDir, 'tailwind-input.css');
const tailwindOutput = join(outDir, 'styles.css');
console.log('[webui] Compiling Tailwind CSS...');
try {
  execSync(
    `npx tailwindcss -i "${tailwindInput}" -o "${tailwindOutput}" --minify`,
    { cwd: root, stdio: 'pipe' },
  );
} catch (e) {
  console.error('[webui] Tailwind build failed:', e.stderr?.toString() ?? e.message);
  process.exit(1);
}

// 2. Bundle client JS with esbuild
console.log('[webui] Bundling client JS with esbuild...');
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

// 3. Copy index.html
copyFileSync(join(clientDir, 'index.html'), join(outDir, 'index.html'));

// 4. Append legacy component CSS (chip, badge, field-row, etc.) used by render.ts helpers
const legacyCssPath = join(clientDir, 'styles.css');
if (existsSync(legacyCssPath)) {
  const legacy = readFileSync(legacyCssPath, 'utf8');
  const tailwind = readFileSync(tailwindOutput, 'utf8');
  writeFileSync(tailwindOutput, tailwind + '\n/* === legacy component styles === */\n' + legacy);
  console.log('[webui] Appended legacy component styles.');
}

console.log('[webui] Build complete.');
