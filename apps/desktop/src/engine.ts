// Deep module, NOT the `@daak/core` barrel: the barrel re-exports NativeDaak,
// which calls TurboModuleRegistry.getEnforcing('Daak') at module-eval time and
// throws in Node. DaemonClient.ts itself says so (packages/core/src/index.ts).
import { DaemonClientEngine } from '@daak/core/src/engine/DaemonClient';
import type { DaakEngine } from '@daak/core';

// This module is in the React Native bundle (index.js imports daakSocketPath)
// and a bundle has no Node runtime: Metro refused to build at all with
// "Unable to resolve module node:path from src/engine.ts". `join` did exactly
// one POSIX join, and the edge case it existed for is the blank base, handled
// by posixJoin below rather than by a module Metro cannot resolve.
function posixJoin(base: string, ...rest: string[]): string {
  // PathBuf::from("").join("daak") is "daak", NOT "/daak". So an empty base
  // must produce a RELATIVE path: filter it out instead of joining onto it.
  // But PathBuf::from("/").join("daak") IS "/daak", so a root base stays
  // absolute. Verified with real rustc across "", "/", "/tmp", "/tmp/",
  // "/tmp//" and "/run/user/501"; the two cases that differ are an empty base
  // and a base that is only slashes, and they must not be collapsed together.
  const trimmed = base.replace(/\/+$/, '');
  const head = trimmed === '' && base !== '' ? '/' : trimmed;
  // The root is a PREFIX, not a segment: joining it as one would emit
  // "//daak". Everything after it is a plain segment list.
  return head === '/' ? `/${rest.join('/')}` : [head, ...rest].filter((p) => p !== '').join('/');
}

// Mirrors daak_ipc::socket_path() (crates/daak-ipc/src/lib.rs:349). Order is
// load-bearing: DAAK_SOCK first on EVERY platform, before the win32 branch and
// before XDG_RUNTIME_DIR. The daemon and every desktop client must derive the
// identical path or the UI silently sees no daemon, and
// packages/core/test/daemon.contract.spec.ts:57 really does spawn daakd with
// DAAK_SOCK set.
export function daakSocketPath(env: Record<string, string | undefined>, platform: string): string {
  // Presence, NOT truthiness: std::env::var returns Err only when the variable
  // is absent, so DAAK_SOCK="" is Ok("") and the daemon listens on the empty
  // path. A truthiness check sends the client somewhere the daemon is not.
  if (env.DAAK_SOCK !== undefined) return env.DAAK_SOCK;
  if (platform === 'win32') return String.raw`\\.\pipe\daakd`;
  // Presence, NOT truthiness, and NOT `??`: std::env::var(..).unwrap_or_else(..)
  // falls back to "/tmp" only when the variable is ABSENT, so a blank
  // XDG_RUNTIME_DIR is the empty base -- the same rule as the DAAK_SOCK branch
  // above. And it is posixJoin(), not a `${base}/daak/daakd.sock` template, because
  // PathBuf::join is a PATH join: PathBuf::from("").join("daak") is "daak",
  // not "/daak" (verified against rustc). A template with an empty base emits
  // "/daak/daakd.sock", which the daemon never binds.
  const runtime = env.XDG_RUNTIME_DIR !== undefined ? env.XDG_RUNTIME_DIR : '/tmp';
  return posixJoin(runtime, 'daak', 'daakd.sock');
}

// Async because DaemonClientEngine's constructor takes an IpcTransport, not a
// path; connect() is the only supported way to build one from a socket path.
export function createDesktopEngine(socketPath: string): Promise<DaakEngine> {
  return DaemonClientEngine.connect(socketPath);
}
