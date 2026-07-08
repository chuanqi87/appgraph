/**
 * ArkTS page extractor. ArkUI's declarative `@Entry @Component struct X { build() {} }`
 * is not valid TypeScript, so (as planned) this is a dedicated focused parser
 * rather than the TS tree-sitter grammar.
 *
 *   @Entry @Component struct SettingsPage { ... }        → Screen (arkts-page)
 *   @Component struct X + 文件内含 NavDestination(       → Screen(Navigation 架构的路由目的地)
 *   router.pushUrl({ url: 'pages/DetailPage' })          → navigates_to target
 */

import { AppNode, makeNodeId, screenMatchKey } from '../../schema';

const ENTRY_STRUCT_RE = /@Entry\b[\s\S]{0,200}?\bstruct\s+([A-Za-z_]\w*)/;
/** Navigation 单入口架构:屏幕是普通 @Component struct,以文件内出现 NavDestination( 为屏幕信号。 */
const COMPONENT_STRUCT_RE = /@Component\b[\s\S]{0,200}?\bstruct\s+([A-Za-z_]\w*)/;
const PAGE_URL_RE = /['"]pages\/([A-Za-z0-9_]+)['"]/g;
/** `NavPathStack.pushPath(ByName)('DetailPage')` — the Navigation router form. */
const PUSH_PATH_RE = /pushPath(?:ByName)?\(\s*['"]([A-Za-z0-9_]+)['"]/g;

export interface ArktsPage {
  /** The @Entry Screen node this file defines, or null if it isn't a page. */
  screen: AppNode | null;
  /** Page basenames this file routes to (e.g. `DetailPage`). */
  navTargets: string[];
}

export function scanArktsPage(filePath: string, source: string): ArktsPage {
  const structName =
    ENTRY_STRUCT_RE.exec(source)?.[1] ??
    (source.includes('NavDestination(') ? (COMPONENT_STRUCT_RE.exec(source)?.[1] ?? null) : null);

  let screen: AppNode | null = null;
  if (structName) {
    const matchKey = screenMatchKey(structName);
    screen = {
      id: makeNodeId('harmony', 'Screen', matchKey),
      kind: 'Screen',
      matchKey,
      name: structName,
      platform: 'harmony',
      subtype: 'arkts-page',
      platformRef: { file: filePath, symbol: structName },
      provenance: 'source-static',
      fidelity: 'source-project',
      confidence: 1,
    };
  }

  const navTargets = new Set<string>();
  for (const m of source.matchAll(PAGE_URL_RE)) if (m[1]) navTargets.add(m[1]);
  for (const m of source.matchAll(PUSH_PATH_RE)) if (m[1]) navTargets.add(m[1]);

  return { screen, navTargets: [...navTargets].sort() };
}
