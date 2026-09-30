#!/usr/bin/env bash
# Phase 6 exit criterion: the daemon outlives client disconnects and the IPC
# socket is mode 0600. Starts a real daakd, checks the socket it left behind,
# then runs the lifecycle test against an in-process daemon.
set -euo pipefail

cd "$(cd "$(dirname "$0")/.." && pwd)"

# mktemp -d is 0700 and ours, which bind() requires: it refuses a parent it
# does not own (crates/daakd/src/lib.rs check_owned_by_us). /tmp would not do.
runtime="$(mktemp -d)"
export XDG_RUNTIME_DIR="$runtime"
# socket_path() joins XDG_RUNTIME_DIR/daak/daakd.sock. DAAK_SOCK is checked
# first and is cleared so the real path is the one under test.
unset DAAK_SOCK

cleanup() {
  [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null || true
  rm -rf "$runtime"
}
trap cleanup EXIT

cargo build -p daakd

# NO ARGUMENTS. daakd has no PORT argument (crates/daakd/src/main.rs calls
# serve_with_store(&socket_path(), store)); the plan's `--listen-port 0` would
# be ignored as argv[1] and nothing more. The engine is configured by the IPC
# Start request. main.rs does accept exactly one flag, `--passphrase-stdin`,
# which is NOT used here: it would block on a stdin this background launch does
# not provide, and the identity would then be unreadable. The engine is
# configured by the IPC Start request.
# The log goes in $runtime, not /tmp: /tmp is world-writable and the name was
# predictable, so a symlink there could redirect the write and concurrent runs
# would clobber each other's. $runtime is ours, 0700, and the trap removes it.
./target/debug/daakd >"$runtime/daakd.log" 2>&1 &
pid=$!

sock="$runtime/daak/daakd.sock"
# The poll's `kill -0` plus the `test -S` below are the liveness evidence: the
# daemon is still running and has a real socket, not a leftover from a crash.
for _ in $(seq 1 50); do
  [ -S "$sock" ] && break
  kill -0 "$pid" 2>/dev/null || { echo "FAIL: daakd exited"; cat "$runtime/daakd.log"; exit 1; }
  sleep 0.1
done
test -S "$sock" || { echo "FAIL: daemon socket missing at $sock"; exit 1; }

mode="$(stat -c '%a' "$sock" 2>/dev/null || stat -f '%Lp' "$sock")"
[ "$mode" = "600" ] || { echo "FAIL: socket mode $mode != 600"; exit 1; }

cargo test -p daakd --test desktop_lifecycle

echo "desktop-smoke: ok"
