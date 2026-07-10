/**
 * P3.4 · `.gitmodules` vendored-submodule path parser.
 *
 * Locks the deterministic extraction of vendored submodule paths (the helper a
 * future appgraph-scoped ignore hook can use to skip third-party submodule
 * source like shadowsocks-android's shadowsocks-rust).
 */

import { describe, it, expect } from 'vitest';
import { parseGitmodulesPaths } from '../../src/appgraph/extractors/git-submodules';

describe('P3.4 · parseGitmodulesPaths', () => {
  it('extracts every submodule path, sorted + deduped + posix-normalized', () => {
    const source = `[submodule "shadowsocks-rust"]
\tpath = core/src/main/rust/shadowsocks-rust
\turl = https://github.com/shadowsocks/shadowsocks-rust.git
[submodule "libev"]
\tpath = core/src/main/jni/libev
\turl = https://example/libev.git
`;
    expect(parseGitmodulesPaths(source)).toEqual([
      'core/src/main/jni/libev',
      'core/src/main/rust/shadowsocks-rust',
    ]);
  });

  it('normalizes backslashes and trailing slashes, and dedupes', () => {
    const source = `[submodule "a"]
    path = vendor\\a\\
[submodule "a-again"]
    path = vendor/a
`;
    expect(parseGitmodulesPaths(source)).toEqual(['vendor/a']);
  });

  it('returns [] for a body with no path entries', () => {
    expect(parseGitmodulesPaths('# empty\n[core]\n\tignorecase = true\n')).toEqual([]);
    expect(parseGitmodulesPaths('')).toEqual([]);
  });
});
