#!/usr/bin/env bash
# Generates the uniffi Kotlin bindings and the Rust cdylib the Android app
# loads at runtime, and drops both where the Gradle build picks them up.
#
# This is the exact counterpart of gen-ios-ffi.sh. Read that one for the WHY on
# the pinned-bindgen trick and the fixed target/ dir; it applies unchanged here.
#
# Layout produced, all inside $OUT:
#   uniffi/daak_ffi/daak_ffi.kt   the Kotlin bindings DaakModule.kt imports
#   jniLibs/<abi>/libdaak_ffi.so  one cdylib per ABI in reactNativeArchitectures
#
# $OUT is apps/mobile/android/app/build, which .gitignore already covers via
# build/ and which Gradle owns: binding the Kotlin source set and the jniLibs
# source set at paths under it means a clean regenerates both with no committed
# generated code and no extra script to remember to run.
set -euo pipefail

cd "$(cd "$(dirname "$0")/../../.." && pwd)"
root="$PWD"

out="apps/mobile/android/app/build/generated/daak-ffi"

export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"

rm -rf "$out"
mkdir -p "$out/uniffi"

# `rm -rf target/<triple>` is the only correct per-triple clean on cargo 1.98.1
# (see the call site), so it is worth one guard: the argument is a bare dir name
# concatenated onto target/, and a stray "" or "debug" would eat something the
# Rust test suites need. Exactly the four triples this script can produce.
clean_triple() {
  case "$1" in
    armv7-linux-androideabi|aarch64-linux-android|i686-linux-android|x86_64-linux-android)
      rm -rf "$root/target/$1"
      ;;
    *)
      echo "refusing to delete target/$1: not a Rust target triple this script builds" >&2
      exit 1
      ;;
  esac
}

# ---------------------------------------------------------------- bindings ---
# uniffi-bindgen is not a workspace member, so it is invoked through a small
# bin built against the exact version Cargo.lock pins. Same generator the crate
# compiled against is the point: DaakModule.kt imports the package and class
# names the generator emits, and a version skew is a compile error in Kotlin.
version="$(awk '/^name = "uniffi_bindgen"$/{getline; gsub(/version = "|"/,""); print; exit}' Cargo.lock)"
echo "uniffi_bindgen pinned at $version"

# A FIXED directory under target/, not mktemp: see gen-ios-ffi.sh. Sharing it
# with the iOS script is deliberate, so the ~200-crate uniffi_bindgen compile
# happens once for the whole repo.
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

# --out-dir is $out, NOT $out/uniffi: uniffi_bindgen already nests the output
# under the namespace, so it writes uniffi/daak_ffi/daak_ffi.kt relative to this
# dir. That is exactly the package path DaakModule.kt imports, and exactly what
# the kotlin.srcDir in app/build.gradle has to point at. Pointing it one level
# deeper yields uniffi/uniffi/daak_ffi and an unresolved import.
"$bindgen" generate --language kotlin crates/daak-ffi/src/daak.udl --out-dir "$out"

# ------------------------------------------------------------------- cdylib ---
# reactNativeArchitectures is the single source of truth for which ABIs ship,
# and it is already the answer for this repo: every arm/x86 Android device and
# every emulator. It is read from gradle.properties rather than duplicated here
# so narrowing it for a smaller build also narrows what gets compiled.
ndk_version="$(sed -n 's/.*ndkVersion = "\([^"]*\)".*/\1/p' apps/mobile/android/build.gradle)"
# SDK root, in the order the Android tooling itself resolves it. Hardcoding
# one path is what made this script fail on a machine that only exports
# ANDROID_SDK_ROOT, or on the stock Gradle one, which writes sdk.dir into
# local.properties instead of exporting anything.
sdk="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
if [ -z "$sdk" ] && [ -f apps/mobile/android/local.properties ]; then
  sdk="$(sed -n 's/^sdk\.dir=//p' apps/mobile/android/local.properties)"
fi
: "${sdk:=/opt/homebrew/share/android-commandlinetools}"
ndk="$sdk/ndk/$ndk_version"
# Host-triple directory is not darwin-x86_64 on every machine (and is not even
# right on Apple Silicon under Rosetta), so glob the one that is actually
# there rather than naming it.
toolchain="$(echo "$ndk"/toolchains/llvm/prebuilt/darwin-*/bin)"
[ -d "$toolchain" ] || {
  echo "no llvm toolchain under $ndk (expected toolchains/llvm/prebuilt/darwin-*/bin)" >&2
  exit 1
}

arches="$(sed -n 's/^reactNativeArchitectures=//p' apps/mobile/android/gradle.properties)"

# The build order is NOT the order in reactNativeArchitectures, and the reason
# is disk (see below): arm64-v8a is the only ABI that matters on real hardware,
# so it is banked in jniLibs/ FIRST and survives longest if the run dies part
# way. Emulators are last because they are the ones a developer can most easily
# give up on. Every configured ABI is still built; only the sequence changes.
order="arm64-v8a armeabi-v7a x86_64 x86"
for abi in $order; do
  # reactNativeArchitectures is still the source of truth for WHICH ABIs ship.
  # $order only says when. Narrowing gradle.properties therefore still narrows
  # the build, it just cannot reorder it.
  case ",$arches," in
    *",$abi,"*) ;;
    *) continue ;;
  esac

  case "$abi" in
    armeabi-v7a) target=armv7-linux-androideabi; clang=armv7a-linux-androideabi21-clang ;;
    arm64-v8a)   target=aarch64-linux-android; clang=aarch64-linux-android21-clang ;;
    x86)         target=i686-linux-android;     clang=i686-linux-android21-clang ;;
    x86_64)      target=x86_64-linux-android;   clang=x86_64-linux-android21-clang ;;
    *) echo "unknown ABI in reactNativeArchitectures: $abi" >&2; exit 1 ;;
  esac

  # API level 21, not the app's minSdk 24: the NDK's own wrappers are generated
  # per API level and 21 is the oldest that has all four clang wrappers, which
  # is what makes one mapping table enough. The cdylib itself only pulls in
  # libdl/libm/libc, all of which are API-1.
  #
  # cc-rs needs CC *and* AR per target (libsqlite3-sys compiles the bundled
  # SQLite C for the host, and a host `ar` would emit Mach-O objects), and cargo
  # needs the LINKER for the final .so.
  #
  # The two tools spell the env var differently and BOTH are needed:
  #   CC_<lower>_<target>          cc-rs (what compiles the bundled SQLite C)
  #   CARGO_TARGET_<UPPER>_<TARGET>_LINKER   cargo (what links the final .so)
  # Underscores before case, or the name never matches the target at all.
  # Built with tr, not ${var^^}: that is bash 4+, and macOS still ships 3.2.
  # tr with an explicit bracket class, not tr - -: BSD tr rejects a bare "-"
  # as a set. macOS ships BSD tr, so this has to be the portable spelling.
  low="$(echo "$target" | tr -- '-' '_')"
  up="$(echo "$low" | tr 'a-z' 'A-Z')"
  echo "building $target ($abi)"
  # Each triple's build directory is ~800M-1G of intermediates to produce a
  # few MB of .so, and there are up to four of them. On a tight disk the whole
  # loop cannot hold all four at once. Clean the PREVIOUS triple before starting
  # the next one rather than after finishing it: the peak is then two triples,
  # not four, and an interrupted run still has the .so it already copied out.
  #
  # `rm -rf target/<triple>`, NOT `cargo clean --target <triple>`. On cargo
  # 1.98.1 the --target flag does NOT scope the delete: it removes the whole
  # target/ tree, target/debug included, which is the 12G the Rust test suites
  # run out of. Verified twice in a scratch crate, offline, with and without a
  # pre-existing debug/ build. `rm -rf` on the named subdirectory is exact.
  # (A bare `cargo clean` is equally wrong for the same reason.)
  if [ -n "${prev_target:-}" ]; then
    echo "cleaning $prev_target (intermediates for an already-copied .so)"
    clean_triple "$prev_target"
  fi
  # If the previous clean was not enough, the machine is genuinely out of room.
  # Say so and stop rather than filling the volume and corrupting the build.
  free_gib="$(df -g /System/Volumes/Data | awk 'NR==2 {print $4}')"
  if [ "${free_gib:-99}" -lt 2 ]; then
    echo "only ${free_gib}GiB free on /System/Volumes/Data; not starting $target" >&2
    echo "free some space (target/<other-triple>, IDE caches) and re-run" >&2
    exit 1
  fi

  # RELEASE, not debug, and this is a size decision as much as a speed one: a
  # debug .so is ~65 MB per ABI, almost all of it debuginfo, and all four of
  # them ship inside the APK. A release one is single-digit MB. It is also the
  # honest artifact: a debug-profile Rust library behind a release APK has no
  # meaning, and gen-ios-ffi.sh already builds release for the same crate.
  #
  # No comment is allowed between `env \` and its command: a line-continuation
  # swallows the next line as another env ARGUMENT, so a comment here silently
  # becomes a variable assignment and cargo is exec'd with a mangled argv.
  env \
    "CC_$low=$toolchain/$clang" \
    "AR_$low=$toolchain/llvm-ar" \
    "CARGO_TARGET_${up}_LINKER=$toolchain/$clang" \
    cargo build --release -p daak-ffi --target "$target"

  mkdir -p "$out/jniLibs/$abi"
  cp "target/$target/release/libdaak_ffi.so" "$out/jniLibs/$abi/libdaak_ffi.so"
  # Verify the copy landed BEFORE anything can delete the source: the clean
  # below removes target/$target, so an unchecked cp would silently leave the
  # ABI missing from the APK with no error anywhere.
  [ -s "$out/jniLibs/$abi/libdaak_ffi.so" ] || {
    echo "copy failed: $out/jniLibs/$abi/libdaak_ffi.so is empty or missing" >&2
    exit 1
  }
  prev_target="$target"
done

# Last triple's intermediates too, for the same reason as the rest.
if [ -n "${prev_target:-}" ]; then
  echo "cleaning $prev_target (final triple)"
  clean_triple "$prev_target"
fi

echo "wrote $out"
