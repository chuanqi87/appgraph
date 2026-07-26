/**
 * Navigation route registry.
 *
 * Locks the three properties that make string-keyed navigation resolvable at
 * all: the profile filename comes from the manifest (never hardcoded), route
 * names are a global namespace, and a duplicated name is dropped rather than
 * arbitrarily picked.
 */

import { describe, it, expect } from 'vitest';
import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadHarmonyProject } from '../../../src/appgraph/extractors/harmony/project';
import { buildRouteRegistry } from '../../../src/appgraph/extractors/harmony/route-map';
import {
  parseResourceRef,
  resolveResourceRef,
} from '../../../src/appgraph/extractors/harmony/resource-ref';

const FIXTURE = join(__dirname, '../../fixtures/harmony-navigation-multi');

/** Write a project-relative file, creating parent dirs. */
function writeFile(root: string, rel: string, content: string): void {
  const abs = join(root, ...rel.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

describe('resource references', () => {
  it('parses $type:name', () => {
    expect(parseResourceRef('$profile:route_map')).toEqual({ type: 'profile', name: 'route_map' });
    expect(parseResourceRef('$string:app_name')).toEqual({ type: 'string', name: 'app_name' });
    expect(parseResourceRef('route_map')).toBeNull();
    expect(parseResourceRef(undefined)).toBeNull();
  });

  it('resolves through the base qualifier directory', () => {
    expect(
      resolveResourceRef(FIXTURE, 'features/order', { type: 'profile', name: 'router_map' })
    ).toBe('features/order/src/main/resources/base/profile/router_map.json');
  });

  it('returns null for a missing resource rather than a guessed path', () => {
    expect(
      resolveResourceRef(FIXTURE, 'features/order', { type: 'profile', name: 'nope' })
    ).toBeNull();
  });
});

describe('route registry', () => {
  const project = loadHarmonyProject(FIXTURE)!;
  const registry = buildRouteRegistry(project);

  it('merges routes from every module into one global namespace', () => {
    expect([...registry.byName.keys()].sort()).toEqual(['HomePage', 'OrderDetail', 'OrderList']);
  });

  it('takes the profile FILENAME from module.json5, not a hardcoded name', () => {
    // entry declares `$profile:route_map`, order declares `$profile:router_map`.
    expect(registry.byName.get('HomePage')!.sourceFile).toContain('/route_map.json');
    expect(registry.byName.get('OrderDetail')!.sourceFile).toContain('/router_map.json');
  });

  it('resolves pageSourceFile against the declaring module dir', () => {
    expect(registry.byName.get('OrderDetail')!.pageFile).toBe(
      'features/order/src/main/ets/views/OrderDetailPage.ets'
    );
  });

  it('keeps the buildFunction — route name, file and struct all differ', () => {
    const route = registry.byName.get('OrderDetail')!;
    expect(route.name).toBe('OrderDetail');
    expect(route.pageFile.endsWith('OrderDetailPage.ets')).toBe(true);
    expect(route.buildFunction).toBe('buildOrderDetailPage');
  });

  it('counts legacy main_pages.json pages alongside Navigation routes', () => {
    // The tally is what distinguishes a legacy-router project from one with no
    // navigation at all; the pages themselves surface as `@Entry` Screens.
    expect(registry.stats.legacyPages).toBe(1);
  });

  it('reports honest stats', () => {
    expect(registry.stats.routes).toBe(3);
    expect(registry.stats.routeMapFiles).toBe(2);
    expect(registry.stats.modulesWithRouterMap).toBe(2);
    expect(registry.stats.duplicates).toBe(0);
  });
});

describe('route registry — ambiguity and gaps', () => {
  const project = loadHarmonyProject(FIXTURE)!;

  it('DROPS both entries when two modules claim one route name', () => {
    // Route names carry no module qualifier, so a cross-module duplicate is
    // genuinely ambiguous at the call site; picking the first would misroute
    // every caller.
    const root = mkdtempSync(join(tmpdir(), 'harmony-route-clash-'));
    try {
      writeFile(root, 'AppScope/app.json5', '{"app":{"bundleName":"com.x.y"}}');
      writeFile(
        root,
        'build-profile.json5',
        JSON.stringify({
          modules: [
            { name: 'a', srcPath: './features/a' },
            { name: 'b', srcPath: './features/b' },
          ],
        })
      );
      for (const [mod, page] of [
        ['a', 'APage.ets'],
        ['b', 'BPage.ets'],
      ]) {
        writeFile(
          root,
          `features/${mod}/src/main/module.json5`,
          `{"module":{"name":"${mod}","type":"har","routerMap":"$profile:route_map"}}`
        );
        writeFile(
          root,
          `features/${mod}/src/main/resources/base/profile/route_map.json`,
          JSON.stringify({
            routerMap: [
              // Both modules claim `Shared`; only `b` also claims `OnlyB`.
              {
                name: 'Shared',
                pageSourceFile: `src/main/ets/${page}`,
                buildFunction: `build${mod}`,
              },
              ...(mod === 'b'
                ? [{ name: 'OnlyB', pageSourceFile: 'src/main/ets/Other.ets', buildFunction: 'x' }]
                : []),
            ],
          })
        );
      }

      const registry = buildRouteRegistry(loadHarmonyProject(root)!);
      expect(registry.duplicates).toContain('Shared');
      expect(registry.byName.has('Shared')).toBe(false);
      expect(registry.warnings.some((w) => w.message.includes('重复注册'))).toBe(true);
      // Unaffected routes survive — one clash is not total failure.
      expect(registry.byName.has('OnlyB')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('warns when a declared routerMap profile does not exist', () => {
    const broken = {
      ...project,
      modules: project.modules.map((m) =>
        m.dir === 'features/order' && m.manifest
          ? { ...m, manifest: { ...m.manifest, routerMap: '$profile:does_not_exist' } }
          : m
      ),
    };
    const registry = buildRouteRegistry(broken);
    expect(registry.warnings.some((w) => w.message.includes('does_not_exist'))).toBe(true);
    // The other module's routes survive — one bad profile is not total failure.
    expect(registry.byName.has('HomePage')).toBe(true);
  });
});
