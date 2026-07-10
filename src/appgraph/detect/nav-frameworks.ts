/**
 * S4 · third-party navigation-framework fingerprints → explicit blind-spot
 * warnings.
 *
 * Screen discovery and navigates_to lifting cover the platform mechanisms
 * (manifest, Compose Navigation, nav-graph XML, explicit intents). Apps built
 * on a third-party navigation/UI framework (Circuit, Conductor, Voyager …)
 * route through APIs none of those passes see — the graph then UNDER-detects
 * screens and navigation while looking perfectly healthy (CatchUp/Circuit:
 * 3 screens, 0 warnings). Silent incompleteness reads as completeness, so a
 * fingerprint hit must surface as a coverageWarning the consuming agent sees.
 *
 * Detection reads the core graph's `import` nodes (same channel as
 * api-capabilities) — zero extra IO.
 */

import { CoverageWarning } from '../schema';
import { Node } from '../../types';

/**
 * Import-prefix fingerprints of navigation frameworks the passes do NOT cover.
 *
 * Circuit is intentionally ABSENT: its screens (`… : Screen` / `@CircuitInject`)
 * and `navigator.goTo(XxxScreen)` navigation are now recovered statically
 * (`detectCircuitScreens` + the `circuit-nav` synthesizer/lift), so it is a
 * covered framework, not a blind spot — flagging it would be a false warning.
 */
const NAV_FRAMEWORK_FINGERPRINTS: ReadonlyArray<{ prefix: string; name: string }> = [
  { prefix: 'com.bluelinelabs.conductor', name: 'Conductor' },
  { prefix: 'com.github.terrakok.cicerone', name: 'Cicerone' },
  { prefix: 'ru.terrakok.cicerone', name: 'Cicerone' },
  { prefix: 'cafe.adriel.voyager', name: 'Voyager' },
  { prefix: 'com.ramcosta.composedestinations', name: 'Compose Destinations' },
];

export interface NavFrameworkResult {
  /** Detected framework names, deduped + sorted. */
  frameworks: string[];
  warnings: CoverageWarning[];
}

/** Fingerprint third-party navigation frameworks from `import` nodes. */
export function detectNavFrameworks(nodes: Node[]): NavFrameworkResult {
  const evidence = new Map<string, { file: string; symbol: string }>(); // name → first import
  for (const node of nodes) {
    if (node.kind !== 'import') continue;
    for (const fp of NAV_FRAMEWORK_FINGERPRINTS) {
      if (node.name === fp.prefix || node.name.startsWith(`${fp.prefix}.`)) {
        if (!evidence.has(fp.name)) evidence.set(fp.name, { file: node.filePath, symbol: node.name });
      }
    }
  }

  const frameworks = [...evidence.keys()].sort();
  const warnings: CoverageWarning[] = frameworks.map((name) => ({
    message:
      `检测到第三方导航框架 ${name}:Screen 识别与 navigates_to 提升不覆盖该框架,` +
      `屏幕清单与页面跳转图很可能不完整——请把导航图当作已知盲区,勿当完整事实使用`,
    ref: evidence.get(name)!,
  }));
  return { frameworks, warnings };
}
