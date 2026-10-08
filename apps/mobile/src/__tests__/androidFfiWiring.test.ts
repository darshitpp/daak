import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// The Android UniFFI wiring is invisible to every other suite: there is no
// JVM/Android test source set in this module, no device, and nothing on the JS
// side notices that the engine cannot load. All three ways this can be wrong
// are SILENT at build time and loud only at the first engine call on a device:
//
//   1. the generated Kotlin bindings are not on a compiled source set, so
//      the uniffi.daak_ffi import in DaakModule.kt cannot resolve;
//   2. the .so is not packaged for an ABI, so Native.load() throws
//      UnsatisfiedLinkError;
//   3. the library the bindings ask JNA for is not the name the cdylib is
//      packaged under, so Native.load() throws even though the .so is right
//      there in the APK.
//
// So these are source-level pins over the three places that decide those
// facts: the generator script, the Gradle wiring that binds its output, and
// the name the bindings are told to load.
const repo = '../../../../';
const read = (p: string) => readFileSync(join(__dirname, repo, p), 'utf8');

const script = 'apps/mobile/scripts/gen-android-ffi.sh';
const appGradle = 'apps/mobile/android/app/build.gradle';
const mainApp = 'apps/mobile/android/app/src/main/java/dev/darshit/daak/MainApplication.kt';
const udl = 'crates/daak-ffi/src/daak.udl';

describe('Android uniffi wiring', () => {
  // (1) The bindings have to exist somewhere Gradle compiles, or the import in
  // DaakModule.kt is unresolvable and :app:compileDebugKotlin fails. Pinned at
  // a path under app/build so nothing generated is committed and a stale copy
  // cannot survive a clean.
  it('generates the Kotlin bindings into a source set Gradle compiles', () => {
    expect(existsSync(join(__dirname, repo, script))).toBe(true);
    const out = /out="([^"]+)"/.exec(read(script))?.[1];
    expect(out).toBeTruthy();
    // Under build/, which apps/mobile/.gitignore already ignores via build/.
    expect(out).toMatch(/\/build\//);

    // Both generated trees have to be named as source sets in the app module.
    // Matched on the PATH plus the source-set call, not on one exact
    // assignment spelling: Gradle accepts `= [...]` and `+= [...]` equally and
    // the operator is not the thing being pinned.
    const gradle = read(appGradle);
    expect(gradle).toMatch(/kotlin\.srcDir.*generated\/daak-ffi/);
    expect(gradle).toMatch(/jniLibs\.srcDir.*generated\/daak-ffi\/jniLibs/);
  });

  // (2) JNA is how the generated bindings reach the cdylib; without it on the
  // classpath every single engine method fails to link, at runtime, on device.
  //
  // The VERSION is what this actually asserts. uniffi 0.28.3's JVM
  // object-cleaner template calls com.sun.jna.internal.Cleaner, which JNA
  // deleted in 5.0 (Java 9 module encapsulation) and reintroduced in 5.13.0.
  // Declaring any 5.0-5.12.x JNA gives a `:app:compileDebugKotlin` failure
  // inside GENERATED code -- "Unresolved reference: Cleaner" -- which no edit
  // to this repo's Kotlin can fix. Matching only `net.java.dev.jna` let a
  // 5.6.0 declaration through and the build died on it, so the floor is
  // pinned here instead.
  it('puts JNA on the app classpath', () => {
    const gradle = read(appGradle);
    expect(gradle).toMatch(/net\.java\.dev\.jna/);
    const version = /jna:([\d.]+)/.exec(gradle)?.[1];
    expect(version).toBeTruthy();
    expect(version).not.toMatch(/^5\.(0|[1-9]|1[0-2])\./); // Cleaner-less window
  });

  // (4) The version above is necessary and NOT sufficient. jna 5.14.0's POM
  // says <packaging>jar</packaging>, so `implementation("net.java.dev.jna:jna:5.14.0")`
  // resolves the JAR, and that jar ships no Android natives at all -- it has
  // aix/darwin/linux/sunos/win32 and zero android-*. The Android build of
  // JNA is published as a SEPARATE artifact with the same coordinates and the
  // .aar extension (jna-5.14.0.aar), which carries jni/arm64-v8a/libjnidispatch.so
  // et al. Gradle picks by packaging, so the plain coordinate never selects it.
  //
  // The failure this guards is the worst shape there is: SILENT at build time,
  // invisible to every JS test, and it only appears as a device-side
  // UnsatisfiedLinkError on the first engine call -- measured on an arm64
  // emulator on 2026-10-01, where the app booted fine and logged
  // "Native library (com/sun/jna/android-aarch64/libjnidispatch.so) not found
  // in resource path (.)" with the engine dead behind it.
  it('resolves JNA as an aar so its android jnidispatch natives are packaged', () => {
    const gradle = read(appGradle);
    // packaging = 'aar' on a module dependency is what forces the variant;
    // the bare coordinate is what silently produced a jar.
    expect(gradle).toMatch(/net\.java\.dev\.jna:jna:[\d.]+@aar/);
  });

  // The generated bindings themselves. This is the check that would have
  // caught the `message` generator bug found on 2026-10-01, which no other
  // suite could see because it compile-fails ONLY on Android: uniffi emits a
  // fielded-error field as a `val` on a kotlin.Exception subclass, where a
  // field named `message` collides with Throwable.message ("Conflicting
  // declarations"). The fix was renaming the UDL field to `reason`.
  //
  // NOTE the deliberate absence of a Cleaner assertion here. uniffi 0.28.3
  // ALWAYS emits com.sun.jna.internal.Cleaner -- it is the JNA version, not
  // the generator, that must provide the class, which is why the check above
  // pins jna >= 5.13.0 instead. Asserting the reference is absent would be
  // asserting that a correct generator is broken.
  //
  // A fielded uniffi error becomes `val <name>` on a class extending
  // kotlin.Exception, so a field named `message` collides with
  // Throwable.message and the Kotlin compiler rejects it outright. The
  // generator emits the name VERBATIM (macros.kt field_name) and the UDL has no
  // escape hatch, so the only defence is not choosing the name - and the only
  // place that choice is recorded is the UDL.
  //
  // This asserts on the UDL, which is COMMITTED, deliberately. An earlier
  // version of this test asserted on the generated .kt and skipped when the
  // file was absent. That was worse than useless: the generated file lives
  // under app/build/, which is gitignored, and the CI js job has no Android
  // SDK and never runs gen-android-ffi.sh - so the one assertion guarding this
  // bug class silently skipped on every CI run. A CI assertion must read a
  // committed file. The generated .kt is better covered by the real Gradle
  // build, which compiles it outright.
  it('never names a uniffi error field `message`', () => {
    const decls = [...read(udl).matchAll(/\[Error\][\s\S]*?(?=\n\[|$)/g)]
      .map((m) => m[0])
      .join('\n');
    // Both error types are present, so an empty match cannot pass silently.
    // FfiError is the flat one (an `enum`), FfiStoreError the fielded one.
    expect(decls).toMatch(/enum FfiError/);
    expect(decls).toMatch(/interface FfiStoreError/);
    for (const line of decls.split('\n')) {
      const fielded = /\b\w+\s*\(\s*string\s+(\w+)\s*[,)]/.exec(line);
      if (fielded) expect(fielded[1]).not.toBe('message');
    }
  });

  // (3) The name mismatch is the trap the ponytail: comment in DaakModule.kt
  // already warned about. uniffi 0.28.3 emits findLibraryName() returning a
  // bare hardcoded name, overridable ONLY through a system property read at
  // first use; there is no UDL keyword for it in 0.28.3. So the fix is the
  // system property, and it has to be set before the first engine call. Pinned
  // against the packaged file name too, so the two cannot drift.
  it('tells JNA the packaged cdylib name, and packages that same name', () => {
    // The exact cp, not just the destination basename: a SOURCE renamed to
    // something else still leaves `libdaak_ffi.so` elsewhere in this file, and
    // the build then dies at the cp with a missing-file error instead of here.
    expect(read(script)).toMatch(
      /cp "target\/\$target\/release\/libdaak_ffi\.so" "\$out\/jniLibs\/\$abi\/libdaak_ffi\.so"/,
    );

    const kt = read(mainApp);
    expect(kt).toMatch(/uniffi\.component\.daak_ffi\.libraryOverride/);
    // The override value must be the library basename JNA wants, NOT the file
    // name: JNA prepends lib and appends the platform suffix itself.
    expect(kt).toMatch(/libraryOverride"\s*,\s*"daak_ffi"/);
  });

  // Every ABI in reactNativeArchitectures has to get a .so, or the app runs
  // and dies on the ABI it was not built for. The script reads the ABI list out
  // of gradle.properties rather than restating it, so this only has to hold in
  // one place.
  it('derives the ABI list from reactNativeArchitectures, not a second copy', () => {
    const s = read(script);
    expect(s).toMatch(/reactNativeArchitectures/);
    expect(s).toMatch(/gradle\.properties/);
  });

  // `rm -rf target/<triple>` is correct on cargo 1.98.1 where `cargo clean
  // --target` is not -- that one deletes the whole target/, which the Rust test
  // suites run out of. So the argument is the one genuinely destructive thing
  // in this script and gets a whitelist instead of a comment.
  it('whitelists the triples it deletes out of target/', () => {
    const guard = /clean_triple\(\) \{([\s\S]*?)\n\}/.exec(read(script))?.[1];
    expect(guard).toBeTruthy();
    for (const t of [
      'armv7-linux-androideabi',
      'aarch64-linux-android',
      'i686-linux-android',
      'x86_64-linux-android',
    ]) {
      expect(guard).toContain(t);
    }
    expect(guard).toMatch(/\*\)[\s\S]*?exit 1/);
    // And every call site routes through the helper, not straight to rm -rf.
    const outside = read(script).replace(/clean_triple\(\) \{[\s\S]*?\n\}/, '');
    expect(outside).not.toMatch(/rm -rf "\$root\/target\//);
  });

  // The iOS script and this one share the fixed target/daak-uniffi-bindgen
  // directory on purpose: one ~200-crate compile for the repo, not one per
  // platform. Drifting to mktemp costs minutes per run, silently.
  it('shares the pinned-bindgen directory with the iOS script', () => {
    expect(read(script)).toContain('target/daak-uniffi-bindgen');
    expect(read('apps/mobile/scripts/gen-ios-ffi.sh')).toContain('target/daak-uniffi-bindgen');
  });

  // B1-1. The pin must come from a TRACKED file. Cargo.lock is untracked and
  // forbidden from staging, so a clean checkout has no lock file, the old awk
  // came back EMPTY, and the script emitted `uniffi = { version = "=" }`, which
  // cargo cannot resolve. Same source pin as iosFfiWiring, minus the pbxproj.
  it('reads the uniffi pin from the tracked crate manifest, not Cargo.lock', () => {
    // Only the command inside the version="$(...)" assignment: the guard's own
    // error message names the manifest, so matching the whole script would be
    // satisfied by a hardcoded version that reads nothing at all.
    const cmd = /^version="\$\((.+)\)"\r?$/m.exec(read(script))?.[1];
    expect(cmd).toBeTruthy();
    expect(cmd).toContain('crates/daak-ffi/Cargo.toml');
    // Comments are stripped: the script's own why-comment names Cargo.lock.
    const code = read(script)
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(code).not.toMatch(/Cargo\.lock/);
  });
});
