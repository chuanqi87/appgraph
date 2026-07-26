/**
 * JSON5 reader — the anti-silence contract.
 *
 * The cases here are lifted verbatim from real corpus files, because the failure
 * that motivated this module was a SILENT one: `jsonc-parser` returned
 * `{dependencies: {}}` for an unquoted-key `oh-package.json5` instead of
 * failing, so 102 modules lost every dependency edge with no warning at all.
 */

import { describe, it, expect } from 'vitest';
import { parseJson5, asObject } from '../../../src/appgraph/extractors/harmony/json5';

describe('parseJson5 — JSON5 grammar coverage', () => {
  it('parses trailing commas (1,647 corpus files)', () => {
    const r = parseJson5('{"targets":[{"name":"default"},{"name":"ohosTest",},],}');
    expect(r.issues).toEqual([]);
    expect(r.degraded).toBe(false);
    expect((r.value as { targets: unknown[] }).targets).toHaveLength(2);
  });

  it('parses line and block comments', () => {
    const r = parseJson5(`{
      "app": {
// todo: 请配置您应用的包名
        "bundleName": "com.atomicservice.xxxxxx",
/*
   todo: 修改应用包名
 */
        "versionCode": 1000000
      }
    }`);
    expect(r.issues).toEqual([]);
    const app = asObject(asObject(r.value)?.app);
    expect(app?.bundleName).toBe('com.atomicservice.xxxxxx');
    expect(app?.versionCode).toBe(1000000);
  });

  it('parses unquoted keys — NavigationTemplate/Metro entry/oh-package.json5', () => {
    const r = parseJson5(`{
      "name": "entry",
      "dependencies": {
        commonlib:    "file:../commons/commonLib",
        componentlib: "file:../commons/componentLib",
        qrcode:       "file:../features/QRCode"
      }
    }`);
    expect(r.issues).toEqual([]);
    const deps = asObject(asObject(r.value)?.dependencies);
    // The regression this guards: these three silently became {} before.
    expect(Object.keys(deps ?? {})).toEqual(['commonlib', 'componentlib', 'qrcode']);
    expect(deps?.qrcode).toBe('file:../features/QRCode');
  });

  it('parses single-quoted values — HouseAndHome/HomeDecoration features/mine', () => {
    const r = parseJson5(`{"dependencies": {"commonlib": 'file:../../commons/commonlib'}}`);
    expect(r.issues).toEqual([]);
    expect(asObject(asObject(r.value)?.dependencies)?.commonlib).toBe(
      'file:../../commons/commonlib'
    );
  });

  it('parses unquoted keys AND single quotes together', () => {
    const r = parseJson5(`{ commonlib: 'file:../x', mine: 'file:../y', }`);
    expect(r.issues).toEqual([]);
    expect(r.value).toEqual({ commonlib: 'file:../x', mine: 'file:../y' });
  });

  it('parses single-quoted permission entries — CarsTemplate/CarBeautyCare', () => {
    const r = parseJson5(`{
      "module": {
        "requestPermissions": [
          { "name": "ohos.permission.INTERNET" },
          { "name": 'ohos.permission.APPROXIMATELY_LOCATION',
            "reason": '$string:permission_reason_location' }
        ]
      }
    }`);
    expect(r.issues).toEqual([]);
    const perms = (asObject(asObject(r.value)?.module)?.requestPermissions ?? []) as Array<{
      name: string;
    }>;
    expect(perms.map((p) => p.name)).toEqual([
      'ohos.permission.INTERNET',
      'ohos.permission.APPROXIMATELY_LOCATION',
    ]);
  });
});

describe('parseJson5 — string content is never damaged', () => {
  it('keeps `//` inside URLs (a regex comment-stripper would corrupt these)', () => {
    const r = parseJson5('{"license":"http://www.apache.org/licenses/LICENSE-2.0"}');
    expect(r.issues).toEqual([]);
    expect((r.value as { license: string }).license).toBe(
      'http://www.apache.org/licenses/LICENSE-2.0'
    );
  });

  it('keeps escaped regex intact — ComprehensiveMall skills[].uris[].pathRegex', () => {
    const r = parseJson5('{"pathRegex":"\\\\b(auth|share)\\\\b","host":"102061317"}');
    expect(r.issues).toEqual([]);
    expect((r.value as { pathRegex: string }).pathRegex).toBe('\\b(auth|share)\\b');
  });

  it('keeps a `/*` sequence that lives inside a string value', () => {
    const r = parseJson5('{"glob":"src/**/*.ets"}');
    expect(r.issues).toEqual([]);
    expect((r.value as { glob: string }).glob).toBe('src/**/*.ets');
  });
});

describe('parseJson5 — anti-silence contract', () => {
  it('reports issues for genuinely broken input instead of returning a clean value', () => {
    const r = parseJson5('{"dependencies": { "a": "file:../a",');
    expect(r.issues.length).toBeGreaterThan(0);
    expect(r.degraded).toBe(true);
  });

  it('NEVER returns a partial value with an empty issues list', () => {
    // The exact shape of the shipped bug: a value that looks complete but isn't.
    const r = parseJson5('{"dependencies": {@@@}}');
    expect(r.issues.length).toBeGreaterThan(0);
  });

  it('a clean parse is never marked degraded', () => {
    const r = parseJson5('{"a":1}');
    expect(r.degraded).toBe(false);
    expect(r.issues).toEqual([]);
  });
});
