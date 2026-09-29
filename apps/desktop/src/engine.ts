// Deep module, NOT the `@daak/core` barrel: the barrel re-exports NativeDaak,
// which calls TurboModuleRegistry.getEnforcing('Daak') at module-eval time and
// throws in Node. DaemonClient.ts itself says so (packages/core/src/index.ts).
import { DaemonClientEngine } from '@daak/core/src/engine/DaemonClient';
import type { DaakEngine } from '@daak/core';
import { join } from 'node:path';

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
  // above. And it is join(), not a `${base}/daak/daakd.sock` template, because
  // PathBuf::join is a PATH join: PathBuf::from("").join("daak") is "daak",
  // not "/daak" (verified against rustc). A template with an empty base emits
  // "/daak/daakd.sock", which the daemon never binds.
  const runtime = env.XDG_RUNTIME_DIR !== undefined ? env.XDG_RUNTIME_DIR : '/tmp';
  return join(runtime, 'daak', 'daakd.sock');
}

// Async because DaemonClientEngine's constructor takes an IpcTransport, not a
// path; connect() is the only supported way to build one from a socket path.
export function createDesktopEngine(socketPath: string): Promise<DaakEngine> {
  return DaemonClientEngine.connect(socketPath);
}
