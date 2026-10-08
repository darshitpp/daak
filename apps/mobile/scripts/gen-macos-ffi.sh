#!/usr/bin/env bash
# Generates the uniffi Swift + C module the macOS app target imports
# (`import daak_ffiFFI` in Daak.swift and KeychainSecureStore.swift), plus the
# Rust staticlib they link against.
#
# The third member of the gen-{ios,android,macos}-ffi.sh family. gen-ios-ffi.sh
# and gen-android-ffi.sh both predate this ruling: Phase 6 assumed desktop got
# its engine from daakd over IPC, so macOS never needed a Rust build of its own.
# D16.10.3 ruled macOS in-process, which makes this mandatory.
#
# Layout produced, all inside $OUT (gitignored, regenerated per native build,
# exactly like the iOS and Android ones):
#   Headers/module.modulemap   the daak_ffiFFI Clang module
#   Headers/daak_ffiFFI.h      the C declarations
#   daak_ffi.swift             the Swift wrapper (DaakEngine, EventSink, ...)
#   lib/libdaak_ffi.a          the Rust staticlib, universal across both arches
set -euo pipefail

cd "$(cd "$(dirname "$0")/../../.." && pwd)"
root="$PWD"

out="apps/desktop/macos/build/generated/ffi"

export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"

rm -rf "$out"
mkdir -p "$out/Headers" "$out/lib"

# The pinned-bindgen trick and the FIXED target/daak-uniffi-bindgen directory
# are copied from gen-ios-ffi.sh and apply unchanged: the generator version has
# to match what the crate compiled against, or the Swift method names Daak.swift
# calls will not exist. Shared with the other two scripts deliberately, so the
# ~200-crate uniffi_bindgen compile happens once for the whole repo.
# From the TRACKED manifest, not from Cargo.lock. Cargo.lock is untracked and
# forbidden from staging, so it cannot be a source of truth: on a clean checkout
# it does not exist and the old awk came back EMPTY, emitting
# `uniffi = { version = "=" }` -- cargo cannot resolve that. Worse, reading it
# when it happens to exist makes the pin differ per machine (=0.28.3 here,
# =0.28 there) off the same commit. A tracked 0.28 requirement resolves to the
# same 0.28.3 everywhere; `=0.28` is what the lockfile path effectively wanted.
#
# The first line: `uniffi` appears TWICE in daak-ffi/Cargo.toml (dependencies and
# build-dependencies) and sed prints both, giving version="0.28
# 0.28" -- an unresolvable requirement.
# The [[:space:]]* in the pattern is defensive slack only: both lines start with
# `uniffi` in column 0, so a bare ^uniffi matches them just as well. It is here
# so a future re-indent of the manifest does not silently empty the pin; it is not
# fixing a bug, because there was never a case here where ^uniffi matched nothing.
# Read the whole output into a variable, then keep the first line, because a
# pipeline that ends in `head -1` is unsafe under `set -o pipefail`.
version_lines="$(sed -n 's/^[[:space:]]*uniffi = { version = "\([0-9.]*\)".*/\1/p' crates/daak-ffi/Cargo.toml)"
version="${version_lines%%$'\n'*}"
test -n "$version" || { echo "cannot read the uniffi pin from crates/daak-ffi/Cargo.toml" >&2; exit 1; }
echo "uniffi_bindgen pinned at $version"

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
  echo "path = \"$bindgen_src/src/main.rs\""
  echo ''
  echo '[workspace]'
} > "$bindgen_src/Cargo.toml"

echo 'fn main() { uniffi::uniffi_bindgen_main(); }' > "$bindgen_src/src/main.rs"

cargo build --release --offline --manifest-path "$bindgen_src/Cargo.toml"
bindgen="$bindgen_src/target/release/daak-uniffi-bindgen"

# --out-dir is $out, NOT $out/uniffi, for the same reason as the other two:
# uniffi_bindgen already nests under the namespace, so $out is where
# daak_ffi.swift and the .h/.modulemap land.
"$bindgen" generate --language swift crates/daak-ffi/src/daak.udl --out-dir "$out"
mv "$out/daak_ffiFFI.h" "$out/Headers/"
mv "$out/daak_ffiFFI.modulemap" "$out/Headers/module.modulemap"

# BOTH host arches, always, and unlike the iOS case this is not a
# just-in-case. The macOS app's deployment target is 11.0 and react-native-macos
# builds a universal binary by default, so the linker wants both slices: an
# Apple Silicon .a alone fails to link on Intel with exactly the "building for
# macOS, but linking in object file built for iOS" shape the iOS script had to
# work around for the simulator. Deriving the pair from `uname -m` would produce
# an .a that works on the build machine and nowhere else.
targets=(aarch64-apple-darwin x86_64-apple-darwin)

libs=()
for t in "${targets[@]}"; do
  cargo build -p daak-ffi --target "$t"
  libs+=("target/$t/debug/libdaak_ffi.a")
done

lipo -create "${libs[@]}" -output "$out/lib/libdaak_ffi.a"
lipo -info "$out/lib/libdaak_ffi.a"

echo "wrote $out"
