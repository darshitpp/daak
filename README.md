# Daak

End-to-end encrypted LAN file and text sharing for iOS, Android, macOS, Windows, and Linux. No internet, no accounts.

**Status:** Phases 0-1 are implemented — the Rust transport core under `crates/` (discovery, framing, chunked transfer, CLI harness). Crypto, persistence, resume, the RR/daemon bindings, and all platform UIs are still to come. The architecture spec lives at `docs/superpowers/specs/2026-09-14-daak-architecture-design.md` (local-only, not version-controlled).

## Develop

Requires a stable Rust toolchain.

```bash
cargo test --workspace
cargo clippy --all-targets -- -D warnings
```

Two-terminal smoke test:

```bash
cargo run -p daak-cli -- serve --dir /tmp/daak-recv
cargo run -p daak-cli -- send --to 127.0.0.1:<port> --files Cargo.toml
```

Large-file memory check (opt in, needs 4 GiB free):

```bash
DAAK_BIG_TEST=1 cargo test -p daak-core --test loopback -- --ignored --nocapture
```

## Not yet implemented

Cryptography (Noise XX), SQLite persistence, resume/outbox, the RR/daemon bindings, and all platform UIs. See the spec's phase plan.
