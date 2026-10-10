// defaultDataDir tells the daemon client where to open the daemon database.
// DAAK_DATA_DIR is the test seam the daemon contract suite uses to give each
// test its own directory, so the suite never writes to the per-user data
// directory. Both cases are pinned here: the override, and the per-user
// default that the override must leave alone when it is unset.
import { afterEach, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { defaultDataDir } from '../src/engine/DaemonClient';

describe('defaultDataDir', () => {
  const saved = process.env.DAAK_DATA_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.DAAK_DATA_DIR;
    else process.env.DAAK_DATA_DIR = saved;
  });

  it('returns DAAK_DATA_DIR when it is set', () => {
    process.env.DAAK_DATA_DIR = '/tmp/daak-default-data-dir-test';
    expect(defaultDataDir()).toBe('/tmp/daak-default-data-dir-test');
  });

  it('returns the per-user default when DAAK_DATA_DIR is unset', () => {
    delete process.env.DAAK_DATA_DIR;
    const home = homedir();
    const expected =
      process.platform === 'darwin'
        ? `${home}/Library/Application Support/dev.darshit.daak`
        : process.platform === 'win32'
          ? `${process.env.LOCALAPPDATA ?? `${home}/AppData/Local`}/Daak/DaakDaemon`
          : `${process.env.XDG_DATA_HOME ?? `${home}/.local/share`}/daak`;
    expect(defaultDataDir()).toBe(expected);
  });
});
