import { describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// NOT the `@daak/core` barrel: its index re-exports NativeDaak, which calls
// TurboModuleRegistry.getEnforcing('Daak') at module-eval time and throws in
// Node. packages/core/test/daemon-client.spec.ts reaches the same FILE through
// the relative specifier '../src/engine/DaemonClient' for the same reason.
import { DaemonClientEngine } from '@daak/core/src/engine/DaemonClient';
import { createDesktopEngine, daakSocketPath } from '../src/engine';

describe('daakSocketPath', () => {
  // daak_ipc::socket_path() (crates/daak-ipc/src/lib.rs:349) checks DAAK_SOCK
  // FIRST on every platform, before the win32 branch and before XDG_RUNTIME_DIR.
  // packages/core/test/daemon.contract.spec.ts:57 spawns daakd with DAAK_SOCK set
  // and expects the client to find it, so a client that ignored the variable
  // would silently talk to no daemon at all.
  it('honours DAAK_SOCK on every platform', () => {
    for (const platform of ['darwin', 'linux', 'win32']) {
      expect(daakSocketPath({ DAAK_SOCK: '/tmp/custom.sock' }, platform)).toBe('/tmp/custom.sock');
    }
  });

  it('prefers DAAK_SOCK over XDG_RUNTIME_DIR', () => {
    expect(daakSocketPath({ DAAK_SOCK: '/tmp/custom.sock', XDG_RUNTIME_DIR: '/run/user/501' }, 'linux'))
      .toBe('/tmp/custom.sock');
  });

  // std::env::var returns Err only when the variable is ABSENT, so a blank
  // DAAK_SOCK is Ok("") and the daemon really does listen on the empty path.
  // A truthiness check here would send the client somewhere else entirely, so
  // the test pins presence, not non-emptiness.
  it('treats a blank DAAK_SOCK as set, on every platform', () => {
    for (const platform of ['darwin', 'linux', 'win32']) {
      expect(daakSocketPath({ DAAK_SOCK: '' }, platform)).toBe('');
    }
  });

  it('uses the XDG runtime dir on unix', () => {
    expect(daakSocketPath({ XDG_RUNTIME_DIR: '/run/user/501' }, 'darwin'))
      .toBe('/run/user/501/daak/daakd.sock');
  });

  it('falls back to /tmp when XDG_RUNTIME_DIR is unset', () => {
    expect(daakSocketPath({}, 'linux')).toBe('/tmp/daak/daakd.sock');
  });

  // Same rule as DAAK_SOCK above, for the same reason:
  // std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(..) falls back to "/tmp"
  // only when the variable is ABSENT. A blank-but-set XDG_RUNTIME_DIR yields
  // PathBuf::from("").join("daak").join("daakd.sock") = "daak/daakd.sock"
  // on the daemon, so that is what the client has to derive too.
  it('treats a blank XDG_RUNTIME_DIR as set, not as the /tmp fallback', () => {
    expect(daakSocketPath({ XDG_RUNTIME_DIR: '' }, 'linux')).toBe('daak/daakd.sock');
    expect(daakSocketPath({ XDG_RUNTIME_DIR: '' }, 'darwin')).toBe('daak/daakd.sock');
  });

  it('uses the named pipe on windows', () => {
    expect(daakSocketPath({}, 'win32')).toBe(String.raw`\\.\pipe\daakd`);
  });
});

describe('createDesktopEngine', () => {
  it('returns a daemon client engine', async () => {
    // The constructor takes an IpcTransport, not a path, so this needs a real
    // listening socket behind DaemonClientEngine.connect().
    const dir = mkdtempSync(join(tmpdir(), 'daak-desktop-'));
    const sock = join(dir, 'daakd.sock');
    const server = createServer();
    try {
      // Inside the try, AND with a reject: the sandbox denies binding a unix
      // socket with EPERM, and `listen(sock, resolve)` alone NEVER SETTLES in
      // that case (the failure arrives as an 'error' event, not a throw), so
      // the await hangs to the test timeout and the finally never runs -- which
      // is how the temp dir leaked. Rejecting makes the throw real, so the
      // finally below always cleans up.
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(sock, resolve);
      });
      expect(await createDesktopEngine(sock)).toBeInstanceOf(DaemonClientEngine);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
