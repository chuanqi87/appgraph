#!/usr/bin/env node
/**
 * appgraph — CLI for the platform-neutral application knowledge graph.
 *
 * Unlike `migrate` (source→target migration deliverable), `appgraph build` emits
 * a standalone `.appgraph/app-graph.json` for ONE project — source or target can
 * each build their own, and a later diff compares the two. It shares the exact
 * builder the migration pipeline uses (`buildAppGraph`), so the two graphs' node
 * sets match node-for-node.
 *
 *   appgraph build   <path> [--platform auto|android|harmony|ios]
 *   appgraph screens <path>   list Screen nodes + their navigation targets
 *   appgraph nav     <path>   list navigates_to edges (screen → screen)
 *   appgraph features<path>   list Feature clusters + member modules
 *   appgraph capabilities <path>   list Capability nodes + HarmonyOS targets
 */

import * as path from 'node:path';
import { Command } from 'commander';
import { CodeGraph } from '../index';
import { CodeSymbolGraph } from './graph-reader';
import { AppEdge, AppGraph, AppNode, AppPlatform } from './schema';
import { appGraphPath } from './paths';
import { buildAppGraph, readAppGraph, writeAppGraph } from './build';

/** v1 producers. auto resolves to android (the only source producer wired today). */
function resolvePlatform(value: string | undefined): AppPlatform {
  const p = (value ?? 'auto').toLowerCase();
  if (p === 'auto' || p === 'android') return 'android';
  if (p === 'harmony' || p === 'ios') {
    throw new Error(
      `appgraph build --platform ${p} 尚未接入(HarmonyOS/iOS 生产者在各自阶段落地);` +
        `当前仅支持 android。目标侧 Harmony 校验请用 “migrate verify”。`
    );
  }
  throw new Error(`未知 --platform “${value}”,可选 auto|android|harmony|ios`);
}

async function cmdBuild(
  pathArg: string,
  options: { out?: string; platform?: string }
): Promise<void> {
  const root = path.resolve(pathArg);
  const platform = resolvePlatform(options.platform);
  const outPath = options.out ? path.resolve(options.out) : appGraphPath(root);

  // Build/refresh the code-symbol index first, then read from it.
  const cg = CodeGraph.isInitialized(root)
    ? await CodeGraph.open(root, { sync: true })
    : await CodeGraph.init(root, { index: true });
  cg.close();

  const reader = CodeSymbolGraph.open(root);
  try {
    const graph = buildAppGraph(root, reader, { platform });
    writeAppGraph(outPath, graph);
    printBuildSummary(graph, outPath);
  } finally {
    reader.close();
  }
}

function printBuildSummary(graph: AppGraph, outPath: string): void {
  const byKind = new Map<string, number>();
  for (const n of graph.nodes) byKind.set(n.kind, (byKind.get(n.kind) ?? 0) + 1);
  console.log(`AppGraph(${graph.platform}) → ${path.relative(process.cwd(), outPath)}`);
  console.log(`  应用 ${graph.app.name}${graph.app.packageName ? ` (${graph.app.packageName})` : ''}`);
  console.log(`  节点 ${graph.nodes.length} · 边 ${graph.edges.length} · 覆盖警告 ${graph.coverageWarnings.length}`);
  const kinds = [...byKind.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  console.log('  ' + kinds.map(([k, c]) => `${k} ${c}`).join(' · '));
}

/** Load the built graph, or fail with guidance to build it first. */
function loadGraph(pathArg: string, out?: string): { root: string; graph: AppGraph } {
  const root = path.resolve(pathArg);
  const outPath = out ? path.resolve(out) : appGraphPath(root);
  const graph = readAppGraph(outPath);
  if (!graph) {
    throw new Error(`未找到应用图 ${outPath},请先运行 “appgraph build ${pathArg}”`);
  }
  return { root, graph };
}

function nameById(graph: AppGraph): Map<string, AppNode> {
  return new Map(graph.nodes.map((n) => [n.id, n]));
}

function pushInto<T>(map: Map<string, T[]>, key: string, value: T): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

function cmdScreens(pathArg: string, options: { out?: string }): void {
  const { graph } = loadGraph(pathArg, options.out);
  const byId = nameById(graph);
  const screens = graph.nodes.filter((n) => n.kind === 'Screen').sort(byName);
  const navFrom = new Map<string, AppEdge[]>();
  for (const e of graph.edges) {
    if (e.kind !== 'navigates_to') continue;
    pushInto(navFrom, e.from, e);
  }
  console.log(`Screen ${screens.length} 个:`);
  for (const s of screens) {
    const targets = (navFrom.get(s.id) ?? [])
      .map((e) => byId.get(e.to)?.name ?? e.to)
      .sort();
    const sub = s.subtype ? ` [${s.subtype}]` : '';
    const nav = targets.length ? ` → ${targets.join(', ')}` : '';
    console.log(`  · ${s.name}${sub}${nav}`);
  }
}

function cmdNav(pathArg: string, options: { out?: string }): void {
  const { graph } = loadGraph(pathArg, options.out);
  const byId = nameById(graph);
  const edges = graph.edges
    .filter((e) => e.kind === 'navigates_to')
    .map((e) => ({
      from: byId.get(e.from)?.name ?? e.from,
      to: byId.get(e.to)?.name ?? e.to,
    }))
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  console.log(`navigates_to ${edges.length} 条:`);
  for (const e of edges) console.log(`  ${e.from} → ${e.to}`);
}

function cmdFeatures(pathArg: string, options: { out?: string }): void {
  const { graph } = loadGraph(pathArg, options.out);
  const byId = nameById(graph);
  const features = graph.nodes.filter((n) => n.kind === 'Feature').sort(byName);
  const members = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.kind !== 'app_contains') continue;
    const from = byId.get(e.from);
    if (from?.kind !== 'Feature') continue;
    const to = byId.get(e.to);
    if (!to) continue;
    pushInto(members, e.from, to.name);
  }
  console.log(`Feature ${features.length} 个:`);
  for (const f of features) {
    const ms = (members.get(f.id) ?? []).sort();
    console.log(`  · ${f.name}${ms.length ? `: ${ms.join(', ')}` : ''}`);
  }
}

function cmdCapabilities(pathArg: string, options: { out?: string }): void {
  const { graph } = loadGraph(pathArg, options.out);
  const caps = graph.nodes.filter((n) => n.kind === 'Capability').sort(byName);
  console.log(`Capability ${caps.length} 个:`);
  for (const c of caps) {
    const target = typeof c.attrs?.harmonyModule === 'string' ? c.attrs.harmonyModule : '(无目标 API 映射)';
    console.log(`  · ${c.name} → ${target}`);
  }
}

function byName(a: AppNode, b: AppNode): number {
  return a.name.localeCompare(b.name);
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name('appgraph')
    .description('平台中立的应用知识图谱:为单个工程(源或目标)构建 .appgraph/app-graph.json 并查询')
    .version('0.1.0');

  program
    .command('build <path>')
    .description('构建应用语义图 → <root>/.appgraph/app-graph.json(与 migrate 结构层同一 builder)')
    .option('--platform <p>', '工程平台 auto|android|harmony|ios(默认 auto→android)')
    .option('-o, --out <file>', '应用图 JSON 输出路径(默认 <root>/.appgraph/app-graph.json)')
    .action(async (pathArg: string, options: { out?: string; platform?: string }) => {
      await cmdBuild(pathArg, options);
    });

  program
    .command('screens <path>')
    .description('列出 Screen 节点及其 navigates_to 目标')
    .option('-o, --out <file>', '应用图 JSON 路径')
    .action((pathArg: string, options: { out?: string }) => cmdScreens(pathArg, options));

  program
    .command('nav <path>')
    .description('列出 navigates_to 页面跳转边')
    .option('-o, --out <file>', '应用图 JSON 路径')
    .action((pathArg: string, options: { out?: string }) => cmdNav(pathArg, options));

  program
    .command('features <path>')
    .description('列出 Feature 功能簇及其成员模块')
    .option('-o, --out <file>', '应用图 JSON 路径')
    .action((pathArg: string, options: { out?: string }) => cmdFeatures(pathArg, options));

  program
    .command('capabilities <path>')
    .description('列出 Capability 能力节点及其 HarmonyOS 目标 API')
    .option('-o, --out <file>', '应用图 JSON 路径')
    .action((pathArg: string, options: { out?: string }) => cmdCapabilities(pathArg, options));

  program
    .command('ui [path]')
    .description('启动本地 Web UI 浏览应用知识图谱(默认停在 AppGraph 标签页,可切换到 CodeGraph)')
    .option('-p, --port <number>', '首选端口(被占用时自动改用空闲端口)')
    .option('--host <address>', '监听地址', '127.0.0.1')
    .option('--no-open', '不自动打开浏览器')
    .action((pathArg: string | undefined, options: { port?: string; host: string; open: boolean }) =>
      cmdUi(pathArg, options)
    );

  return program;
}

async function cmdUi(
  pathArg: string | undefined,
  options: { port?: string; host: string; open: boolean }
): Promise<void> {
  const root = path.resolve(pathArg ?? '.');
  // Shares the exact server `codegraph ui` starts — same JSON API, same
  // client — this command only differs by which tab it opens to.
  const { startWebUiServer } = await import('../webui/server');
  const server = await startWebUiServer(root, {
    port: options.port ? parseInt(options.port, 10) : undefined,
    host: options.host,
    open: options.open,
    initialLayer: 'appgraph',
  });
  console.log(`Web UI 运行于 ${server.url}`);
  console.log('按 Ctrl+C 停止');
}

async function main(): Promise<void> {
  try {
    await buildProgram().parseAsync(process.argv);
  } catch (err) {
    console.error(`错误:${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}

export { buildProgram };
