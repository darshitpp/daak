#!/usr/bin/env bash
# Generates the uniffi Swift + C module the iOS app target imports
# (`import daak_ffiFFI` in Daak.swift and Daak/KeychainSecureStore.swift).
#
# NOT committed: it lives under apps/mobile/ios/build/, which .gitignore
# already covers, and is regenerated on every native build the same way RN's own
# codegen output in that directory is. An xcframework checked into the tree is
# Phase 8 packaging work, not this.
#
# Layout produced, all inside $OUT:
#   Headers/module.modulemap   the daak_ffiFFI Clang module
#   Headers/daak_ffiFFI.h      the C declarations
#   daak_ffi.swift             the Swift wrapper (DaakEngine, EventSink, ...)
#   lib/libdaak_ffi.a          the Rust staticlib (fat: both sim arches)
set -euo pipefail

cd "$(cd "$(dirname "$0")/../../.." && pwd)"
root="$PWD"

out="apps/mobile/ios/build/generated/ffi"

export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"

rm -rf "$out"
mkdir -p "$out/Headers" "$out/lib"

# uniffi-bindgen is not a workspace member, so it is invoked through a small
# bin built against the same version the crate compiles against. Same generator
# is the point: the generated class and method names have to match what Daak.swift
# calls.
#
# From the TRACKED manifest, not from Cargo.lock. Cargo.lock is untracked and
# forbidden from staging, so it is not part of the commit and cannot pin
# anything reproducibly: on a clean checkout it does not exist, the old awk
# came back EMPTY, and the script emitted `uniffi = { version = "=" }`, which
# cargo cannot resolve. Worse, reading it when it happens to exist makes the pin
# differ per machine (=0.28.3 here, =0.28 there) off the same commit. A tracked
# 0.28 requirement resolves to the same 0.28.3 everywhere; `=0.28` is what the
# lockfile path effectively wanted.
#
# The first line: `uniffi` appears TWICE in daak-ffi/Cargo.toml (dependencies and
# build-dependencies) and sed prints both, giving version="0.28
# 0.28" -- an unresolvable requirement. That is a real bug the first attempt at
# this line had, found by running it.
# Read the whole output into a variable, then keep the first line, because a
# pipeline that ends in `head -1` is unsafe under `set -o pipefail`.
version_lines="$(sed -n 's/^[[:space:]]*uniffi = { version = "\([0-9.]*\)".*/\1/p' crates/daak-ffi/Cargo.toml)"
version="${version_lines%%$'\n'*}"
test -n "$version" || { echo "cannot read the uniffi pin from crates/daak-ffi/Cargo.toml" >&2; exit 1; }
echo "uniffi_bindgen pinned at $version"

# A FIXED directory under target/, not mktemp: a throwaway path gets a fresh
# empty target dir on every run, so each native rebuild paid a full ~200-crate
# uniffi_bindgen compile (minutes) before it could even regenerate the Swift.
bindgen_src="$root/target/daak-uniffi-bindgen"
mkdir -p "$bindgen_src/src"

{
  echo '[package]'
  echo 'name = "daak-uniffi-bindgen"'
  echo 'version = "0.0.0"'
  echo 'edition = "2021"'
  echo ''
  echo '[dependencies]'
  echo "uniffi = { version = \"=$version\", features = [\"cli\"] }"
  echo ''
  echo '[[bin]]'
  echo 'name = "daak-uniffi-bindgen"'
  # Absolute: cargo resolves a bin path relative to the MANIFEST's directory,
  # and this manifest already lives in that directory's parent.
  echo "path = \"$bindgen_src/src/main.rs\""
  echo ''
  # An empty [workspace] table keeps this throwaway package OUT of the daak
  # workspace, which it must be: without it cargo refuses to build a manifest
  # nested under the workspace root.
  echo '[workspace]'
} > "$bindgen_src/Cargo.toml"

echo 'fn main() { uniffi::uniffi_bindgen_main(); }' > "$bindgen_src/src/main.rs"

cargo build --release --offline --manifest-path "$bindgen_src/Cargo.toml"
bindgen="$bindgen_src/target/release/daak-uniffi-bindgen"

"$bindgen" generate --language swift crates/daak-ffi/src/daak.udl --out-dir "$out"
mv "$out/daak_ffiFFI.h" "$out/Headers/"
mv "$out/daak_ffiFFI.modulemap" "$out/Headers/module.modulemap"

# The Xcode build phase passes the triple in DAAK_IOS_RUST_TARGET, derived from
# PLATFORM_NAME: a device/archive build needs aarch64-apple-ios and would not
# link a simulator slice. The positional argument is for running by hand.
rust_target="${1:-${DAAK_IOS_RUST_TARGET:-aarch64-apple-ios-sim}}"
case "$rust_target" in
  aarch64-apple-ios-sim)
    # BOTH simulator arches, not just arm64. The iOS Simulator SDK is a
    # universal arm64 + x86_64 slice, so a Debug build compiles the app for both
    # and a single-arch .a fails to link the other one with "building for iOS
    # Simulator, but linking in object file built for iOS". x86_64 is only ever
    # exercised by an Intel simulator host, but the linker still wants the
    # slice to exist.
    targets=(aarch64-apple-ios-sim x86_64-apple-ios)
    ;;
  *)
    targets=("$rust_target")
    ;;
esac

libs=()
for t in "${targets[@]}"; do
  cargo build -p daak-ffi --target "$t"
  libs+=("target/$t/debug/libdaak_ffi.a")
done

if [ "${#libs[@]}" -gt 1 ]; then
  lipo -create "${libs[@]}" -output "$out/lib/libdaak_ffi.a"
else
  cp "${libs[0]}" "$out/lib/libdaak_ffi.a"
fi
lipo -info "$out/lib/libdaak_ffi.a"

echo "wrote $out"
