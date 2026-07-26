#!/usr/bin/env node
/**
 * HarmonyOS producer quality probe.
 *
 * Builds `.appgraph/app-graph.json` for each configured project and scores it
 * against GROUND TRUTH computed here, by an implementation deliberately
 * independent of the product code (plain regex/glob over the raw files). Reusing
 * the product's own parsers would make the probe agree with the product by
 * construction and measure nothing.
 *
 * Hard criteria (a regression in any of these is a bug, not a tuning issue):
 *   determinism        two builds byte-identical
 *   moduleRecall       every module declared in the root build-profile
 *   moduleDepRecall    every `file:` dependency that targets a declared module
 *   permissionRecall   every distinct ohos.permission.* in the manifests
 *   routeRegistryRecall every route name in every route-map profile
 *   json5Health        zero files whose facts were lost to a parse failure
 *   antiSilence        any shortfall MUST carry a coverage warning
 *
 * Measured-and-reported (no threshold — these establish the baseline):
 *   routeScreenRate · routeInboundRate · screens · navEdges · dataModels
 *   capabilities · wallClock
 *
 * Usage:
 *   node scripts/appgraph-eval/harmony-probe.mjs [--projects <json>] [--out <dir>]
 *                                                [--corpus <dir>] [--only <substr>]
 */

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = join(REPO, 'dist/appgraph/cli.js');

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    projects: join(REPO, 'scripts/appgraph-eval/harmony-projects.json'),
    out: join(REPO, '.eval/harmony', stamp()),
    corpus: null,
    only: null,
  };
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (key && key in out) out[key] = argv[i + 1];
  }
  return out;
}

function stamp() {
  // Date is fine here: this is a CLI, not a resumable workflow script.
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// ---------------------------------------------------------------------------
// ground truth — independent of the product code, on purpose
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  'oh_modules',
  'build',
  '.preview',
  'node_modules',
  '.git',
  '.appgraph',
  '.codegraph',
  'ohpm_custom_dependency',
]);

function walk(dir, onFile, depth = 0) {
  if (depth > 12) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), onFile, depth + 1);
    } else {
      onFile(join(dir, e.name));
    }
  }
}

/** Strip comments so a regex probe isn't fooled by commented-out config. */
function decomment(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function groundTruth(root) {
  const profilePath = join(root, 'build-profile.json5');
  if (!existsSync(profilePath)) {
    // Not a project root. Hybrid repos (Flutter + `ohos/`) and template repos
    // that wrap the app in `Application/` are the common cause — the configured
    // path is wrong, which is worth an explicit error rather than a zeroed row.
    throw new Error(`${root} 下没有 build-profile.json5,不是鸿蒙工程根(检查 harmony-projects.json 的路径)`);
  }
  const profile = decomment(readFileSync(profilePath, 'utf8'));
  // Modules: `"srcPath": "./features/order"` in the ROOT build-profile only.
  const moduleDirs = [...profile.matchAll(/["']?srcPath["']?\s*:\s*["']([^"']+)["']/g)].map((m) =>
    m[1].replace(/^\.\//, '').replace(/\/+$/, '')
  );
  const moduleDirSet = new Set(moduleDirs);

  let depsToDeclared = 0;
  let depsTotal = 0;
  const permissions = new Set();
  const routeNames = new Set();
  let json5Files = 0;
  let etsFiles = 0;

  walk(root, (abs) => {
    const rel = relative(root, abs).split('\\').join('/');
    if (rel.endsWith('.ets')) etsFiles++;
    if (rel.endsWith('.json5')) json5Files++;

    // Dependencies: every `<key>: "file:<path>"` in a module oh-package.
    if (rel.endsWith('oh-package.json5')) {
      const text = decomment(readFileSync(abs, 'utf8'));
      const modDir = dirname(rel) === '.' ? '' : dirname(rel);
      for (const m of text.matchAll(/["']?([\w.@/-]+)["']?\s*:\s*["']file:([^"']+)["']/g)) {
        depsTotal++;
        const target = normalizeJoin(modDir, m[2]);
        if (moduleDirSet.has(target)) depsToDeclared++;
      }
    }

    // Permissions: only `src/main` manifests (ohosTest ones are test-only).
    if (rel.endsWith('src/main/module.json5')) {
      const text = decomment(readFileSync(abs, 'utf8'));
      for (const m of text.matchAll(/ohos\.permission\.[A-Z_0-9]+/g)) permissions.add(m[0]);
    }

    // Routes: any profile json holding a `routerMap` array.
    if (rel.includes('/resources/') && rel.endsWith('.json')) {
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(abs, 'utf8'));
      } catch {
        return;
      }
      if (!Array.isArray(parsed?.routerMap)) return;
      for (const r of parsed.routerMap) if (r?.name) routeNames.add(r.name);
    }
  });

  return {
    moduleDirs: [...moduleDirSet].sort(),
    modules: moduleDirSet.size,
    depsToDeclared,
    depsTotal,
    permissions: [...permissions].sort(),
    routeNames: [...routeNames].sort(),
    json5Files,
    etsFiles,
  };
}

/** posix-join a module dir with a relative `file:` target. */
function normalizeJoin(base, rel) {
  const segs = base ? base.split('/') : [];
  for (const part of rel.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') segs.pop();
    else segs.push(part);
  }
  return segs.join('/');
}

// ---------------------------------------------------------------------------
// per-project run
// ---------------------------------------------------------------------------

function buildGraph(root) {
  const started = Date.now();
  execFileSync('node', [CLI, 'build', root, '--platform', 'harmony'], {
    stdio: 'pipe',
    maxBuffer: 1 << 28,
  });
  const seconds = (Date.now() - started) / 1000;
  const path = join(root, '.appgraph/app-graph.json');
  const raw = readFileSync(path, 'utf8');
  return { graph: JSON.parse(raw), sha: sha256(raw), seconds };
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function evaluate(name, srcRoot) {
  const work = mkdtempSync(join(tmpdir(), 'harmony-probe-'));
  const root = join(work, 'project');
  try {
    cpSync(srcRoot, root, { recursive: true });
    rmSync(join(root, '.codegraph'), { recursive: true, force: true });
    rmSync(join(root, '.appgraph'), { recursive: true, force: true });

    const truth = groundTruth(root);
    const first = buildGraph(root);
    const second = buildGraph(root); // determinism: same source, same bytes
    const g = first.graph;

    const byKind = (k) => g.nodes.filter((n) => n.kind === k);
    const warnings = g.coverageWarnings.map((w) => w.message);
    const screens = byKind('Screen');
    const navEdges = g.edges.filter((e) => e.kind === 'navigates_to');

    const registered = new Set(truth.routeNames);
    // A page can serve several route names, so read the accumulated list.
    const routedScreens = new Set(screens.flatMap((s) => s.attrs?.routes ?? []));
    // Only REGISTERED route names count as inbound coverage. `loadContent`
    // edges carry a page path (`views/Index`), not a route name, so counting
    // them would push the rate above 1 and mask a real shortfall.
    const reachedRoutes = new Set(
      navEdges
        .filter((e) => e.attrs?.via !== 'loadContent')
        .map((e) => e.attrs?.route)
        .filter((r) => typeof r === 'string' && registered.has(r))
    );

    const metrics = {
      // --- hard criteria ---------------------------------------------------
      determinism: first.sha === second.sha,
      moduleRecall: ratio(byKind('ArchModule').length, truth.modules),
      moduleDepRecall: ratio(
        g.edges.filter((e) => e.kind === 'depends_on' && e.provenance === 'manifest').length,
        truth.depsToDeclared
      ),
      permissionRecall: ratio(byKind('Permission').length, truth.permissions.length),
      routeRegistryRecall: ratio(routedScreens.size + countUnresolvedRoutes(warnings), truth.routeNames.length),
      json5Health: countJson5Failures(warnings),
      // --- measured --------------------------------------------------------
      routeScreenRate: rate(routedScreens.size, truth.routeNames.length),
      routeInboundRate: rate(reachedRoutes.size, truth.routeNames.length),
      screens: screens.length,
      navEdges: navEdges.length,
      appEntries: byKind('AppEntry').length,
      backgroundComponents: byKind('BackgroundComponent').length,
      deepLinks: byKind('Resource').length,
      dataModels: byKind('DataModel').length,
      capabilities: byKind('Capability').length,
      features: byKind('Feature').length,
      warnings: warnings.length,
      seconds: Number(first.seconds.toFixed(1)),
    };

    // Anti-silence: any shortfall must be visible in the warnings.
    metrics.antiSilence =
      metrics.routeInboundRate === 1 || truth.routeNames.length === 0
        ? true
        : warnings.some((w) => w.includes('路由') || w.includes('导航'));

    return {
      name,
      truth: {
        modules: truth.modules,
        deps: truth.depsToDeclared,
        depsTotal: truth.depsTotal,
        permissions: truth.permissions.length,
        routes: truth.routeNames.length,
        json5Files: truth.json5Files,
        etsFiles: truth.etsFiles,
      },
      metrics,
      supportedKinds: g.supportedKinds,
      warningTopics: topics(warnings),
      unreachedRoutes: [...truth.routeNames].filter((r) => !reachedRoutes.has(r)).slice(0, 20),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function ratio(got, expected) {
  return { got, expected, ok: got === expected };
}

function rate(got, expected) {
  return expected === 0 ? 1 : Number((got / expected).toFixed(3));
}

/** Routes the page pass saw but could not bind to a struct — still "recalled". */
function countUnresolvedRoutes(warnings) {
  return warnings.filter((w) => w.includes('未找到对应的组件 struct')).length;
}

function countJson5Failures(warnings) {
  return warnings.filter((w) => w.includes('解析失败或仅部分恢复')).length;
}

function topics(warnings) {
  const counts = new Map();
  for (const w of warnings) {
    const topic = w.includes('未映射到能力词表')
      ? '权限未映射能力'
      : w.includes('无任何静态跳转来源')
        ? '路由无入边'
        : w.includes('未找到对应的组件 struct')
          ? '路由页面无 struct'
          : w.includes('解析失败')
            ? 'JSON5 解析失败'
            : w.includes('强隐式耦合')
              ? '隐式耦合待确认'
              : w.includes('未在工程模块清单中找到')
                ? '依赖指向非声明模块'
                : '其他';
    counts.set(topic, (counts.get(topic) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]));
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

function renderMarkdown(results) {
  const head = [
    '| Project | mods | ets | det | modRec | depRec | permRec | routeReg | routeScr | routeIn | screens | nav | data | caps | json5 | warns | secs |',
    '|---|---:|---:|:---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  const rows = results.map((r) => {
    const m = r.metrics;
    const R = (x) => `${x.got}/${x.expected}${x.ok ? '' : ' ✗'}`;
    return `| ${r.name} | ${r.truth.modules} | ${r.truth.etsFiles} | ${m.determinism ? '✓' : '✗'} | ${R(m.moduleRecall)} | ${R(m.moduleDepRecall)} | ${R(m.permissionRecall)} | ${R(m.routeRegistryRecall)} | ${m.routeScreenRate} | ${m.routeInboundRate} | ${m.screens} | ${m.navEdges} | ${m.dataModels} | ${m.capabilities} | ${m.json5Health} | ${m.warnings} | ${m.seconds} |`;
  });

  const failures = [];
  for (const r of results) {
    const m = r.metrics;
    if (!m.determinism) failures.push(`${r.name}: 两次构建字节不一致`);
    for (const [key, label] of [
      ['moduleRecall', '模块召回'],
      ['moduleDepRecall', '依赖召回'],
      ['permissionRecall', '权限召回'],
      ['routeRegistryRecall', '路由注册表召回'],
    ]) {
      if (!m[key].ok) failures.push(`${r.name}: ${label} ${m[key].got}/${m[key].expected}`);
    }
    if (m.json5Health !== 0) failures.push(`${r.name}: ${m.json5Health} 个 JSON5 文件事实丢失`);
    if (!m.antiSilence) failures.push(`${r.name}: 覆盖不足但无任何告警（静默失败）`);
  }

  const topicTotals = new Map();
  for (const r of results) {
    for (const [t, n] of Object.entries(r.warningTopics)) {
      topicTotals.set(t, (topicTotals.get(t) ?? 0) + n);
    }
  }

  return [
    '# HarmonyOS 生产者质量报告',
    '',
    `工程数 ${results.length} · 模块合计 ${results.reduce((a, r) => a + r.truth.modules, 0)} · ` +
      `.ets 合计 ${results.reduce((a, r) => a + r.truth.etsFiles, 0)}`,
    '',
    '## 指标矩阵',
    '',
    ...head,
    ...rows,
    '',
    '## 硬性判据',
    '',
    failures.length === 0
      ? '全部通过：确定性、模块召回、依赖召回、权限召回、路由注册表召回、JSON5 健康度、anti-silence。'
      : failures.map((f) => `- ✗ ${f}`).join('\n'),
    '',
    '## 覆盖警告主题分布',
    '',
    ...[...topicTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `- ${t}：${n}`),
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv);
  if (!existsSync(CLI)) {
    console.error(`未找到 ${CLI}，请先运行 npm run build`);
    process.exit(1);
  }

  const config = JSON.parse(readFileSync(args.projects, 'utf8'));
  // No machine-specific path is committed, so the corpus location must come
  // from the caller: --corpus, $HARMONY_CORPUS, or a locally-edited config.
  const corpus = args.corpus ?? process.env.HARMONY_CORPUS ?? config.corpus;
  if (!corpus) {
    console.error(
      '未指定语料库位置。用 --corpus <dir> 或设置 HARMONY_CORPUS 指向 ' +
        'agc-template-market-harmonyos-demos 的 checkout。'
    );
    process.exit(1);
  }
  const outDir = args.out;
  mkdirSync(outDir, { recursive: true });

  const results = [];
  for (const entry of config.projects) {
    if (args.only && !entry.path.includes(args.only)) continue;
    const srcRoot = join(corpus, entry.path);
    const name = entry.path.split('/').pop();
    if (!existsSync(srcRoot) || !statSync(srcRoot).isDirectory()) {
      console.error(`跳过 ${entry.path}：目录不存在`);
      continue;
    }
    process.stdout.write(`[probe] ${entry.path} … `);
    try {
      const result = evaluate(name, srcRoot);
      results.push(result);
      const m = result.metrics;
      console.log(
        `模块 ${m.moduleRecall.got}/${m.moduleRecall.expected} · ` +
          `屏幕 ${m.screens} · 导航 ${m.navEdges} · ${m.seconds}s`
      );
      writeFileSync(join(outDir, `${name}.json`), JSON.stringify(result, null, 2));
    } catch (err) {
      console.log(`失败：${err.message}`);
      results.push({ name, error: String(err.message) });
    }
  }

  const ok = results.filter((r) => !r.error);
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(results, null, 2));
  const md = renderMarkdown(ok);
  writeFileSync(join(outDir, 'summary.md'), md);
  console.log(`\n报告 → ${outDir}/summary.md\n`);
  console.log(md);
}

main();
