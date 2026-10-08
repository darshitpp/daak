# Daak

End-to-end encrypted LAN file and text sharing for iOS, Android, macOS, Windows, and Linux. No internet, no accounts.

**Status:** Phases 0-1 are implemented — the Rust transport core under `crates/` (discovery, framing, chunked transfer, CLI harness). Crypto, persistence, resume, the RR/daemon bindings, and all platform UIs are still to come. The architecture spec lives at `docs/superpowers/specs/2026-09-14-daak-architecture-design.md` (local-only, not version-controlled).

## Install

Daak ships three targets. Download each artifact from the GitHub Releases page
of `darshitpp/daak`. Windows and Linux are not released.

### Android

Download `Daak-0.1.0.apk`. The package is `dev.darshit.daak`. The version name
is 0.1.0. The version code is 1. The file holds four ABIs and the Hermes VM.

1. Download `Daak-0.1.0.apk`.
2. Open the file on the device.
3. Allow the install from this source when the system asks.

Verify the signer before you install the file. Run this command:

    apksigner verify --print-certs Daak-0.1.0.apk

`apksigner` ships in the Android build-tools.

The printed `SHA-256 digest` must equal this fingerprint:

    0D:82:5C:DC:00:69:C9:17:6B:C9:23:2F:4B:E5:A5:26:6D:51:88:8F:54:C8:FC:2F:F1:23:C5:B4:1F:8F:9D:F5

A different digest means that a different key signed the file. Stop. You must
not install the file.

### macOS

Download `Daak-0.1.0.dmg`. An Apple Development certificate signs the app.
Apple did not notarize the app. Gatekeeper rejects the app on the first open.
This behavior is expected.

1. Open `Daak-0.1.0.dmg`.
2. Move `Daak.app` to the Applications folder.
3. Right-click `Daak.app` then click Open.

You can also remove the quarantine attribute:

    xattr -dr com.apple.quarantine /Applications/Daak.app

### iOS

Download `Daak-0.1.0.ipa`. No signature covers this file. Sign the file with a
free Apple ID through AltStore or SideStore. The profile lasts 7 days. After 7
days, sign the file again.

The app holds no share extension. The iOS share sheet cannot send a file to
Daak.

1. Install AltStore or SideStore on the device.
2. Download `Daak-0.1.0.ipa`.
3. Sign and install the file with the free Apple ID.
4. Open the app and finish onboarding.

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
