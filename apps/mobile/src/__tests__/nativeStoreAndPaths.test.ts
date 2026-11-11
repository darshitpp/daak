import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// No JVM/Android or Xcode test source set exists in this module, and this host
// has neither SDK, so the manifests and the native sources are the parts of the
// keystore / data-dir / reveal path that can still be asserted. Source-level
// pins, not behavioural tests: each one guards something that is SILENT when
// wrong (an identity that regenerates, an engine data dir outside the sandbox, a
// TurboModule that is never registered).
const read = (p: string) => readFileSync(join(__dirname, p), 'utf8');
const has = (p: string) => existsSync(join(__dirname, p));
const repo = '../../../../';

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(__dirname, dir))) {
    if (name === 'node_modules' || name === 'Pods' || name === 'build') continue;
    const p = join(dir, name);
    if (statSync(join(__dirname, p)).isDirectory()) out.push(...sourcesUnder(p));
    else if (/\.(kt|swift|mm|ts|gradle|xml|json)$/.test(name)) out.push(read(p));
  }
  return out;
}

const MODULES = [
  { dir: 'rn-clipboard', name: 'DaakClipboard', pkg: 'dev.darshit.daak.clipboard' },
  { dir: 'rn-fspaths', name: 'DaakFsPaths', pkg: 'dev.darshit.daak.fspaths' },
  { dir: 'rn-securestore', name: 'DaakSecureStore', pkg: 'dev.darshit.daak.securestore' },
];

describe.each(MODULES)('modules/$dir has the full rn-share shape', (m) => {
  const base = repo + 'modules/' + m.dir + '/';
  const pkgDir = 'dev/darshit/daak/' + m.dir.replace('rn-', '');

  // These are the exact Criticals that killed Task 4 and Task 8. Every one of
  // them is silent: a missing file compiles fine until the app boots.
  it('has every file rn-share has', () => {
    for (const f of [
      'package.json',
      'js/Native' + m.name + '.ts',
      'js/index.ts',
      'ios/' + m.name + '.swift',
      'ios/' + m.name + '.mm',
      'ios/' + m.name + '.podspec',
      'android/build.gradle',
      'android/src/main/AndroidManifest.xml',
      'android/src/main/java/' + pkgDir + '/' + m.name + 'Module.kt',
      'android/src/main/java/' + pkgDir + '/' + m.name + 'Package.kt',
    ]) {
      expect(has(base + f)).toBe(true);
    }
  });

  // Omitting this plugin means library codegen never registers, so
  // Native<Name>Spec is never generated and nothing compiles. A Task 4
  // Critical, so it is pinned rather than trusted.
  it('applies com.facebook.react so codegen registers the library', () => {
    const gradle = read(base + 'android/build.gradle');
    expect(gradle).toMatch(/apply plugin: 'com\.facebook\.react'/);
    expect(gradle).toMatch(/minSdkVersion 26/);
    expect(gradle).toContain("namespace '" + m.pkg + "'");
  });

  // R44: a getEnforcing<any> compiles, links, and then loses every type error
  // the Spec exists to catch. Each Spec must be typed by its own interface.
  it('types the TurboModule by its Spec, never getEnforcing<any>', () => {
    const spec = read(base + 'js/Native' + m.name + '.ts');
    expect(spec).toMatch("TurboModuleRegistry.getEnforcing<Spec>('" + m.name + "')");
    expect(spec).not.toMatch(/getEnforcing<any>/);
    expect(spec).toMatch(/export interface Spec extends TurboModule/);
  });

  // A BaseReactPackage that nothing registers is the other half of the same
  // Critical: the class existing proves nothing about the registry.
  it('declares a BaseReactPackage that returns the module by name', () => {
    const pkg = read(base + 'android/src/main/java/' + pkgDir + '/' + m.name + 'Package.kt');
    expect(pkg).toMatch(/class \w+Package : BaseReactPackage\(\)/);
    expect(pkg).toMatch(/isTurboModule = \*\/ true/);
  });
});

describe('the Android Keystore store', () => {
  const store = read(
    repo +
      'modules/rn-securestore/android/src/main/java/dev/darshit/daak/securestore/DaakSecureStoreModule.kt',
  );
  // Comments are stripped for the ban assertions: a comment that NAMES the API
  // it rejects to explain the rejection must not read as calling it.
  const code = store
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n');

  // Stated, not assumed: this is the GCM safety property. Randomized encryption
  // forces a fresh IV per write, which is the only reason one AES key may be
  // reused across a long-lived device identity.
  it('creates the AES-GCM key with randomized encryption required', () => {
    expect(store).toMatch(/\.setRandomizedEncryptionRequired\(true\)/);
    expect(store).toMatch(/KeyProperties\.BLOCK_MODE_GCM/);
    expect(store).toMatch(/KeyProperties\.ENCRYPTION_PADDING_NONE/);
  });

  // This would put a biometric or device-credential prompt in front of EVERY
  // engine call, including the background accept loop that has no UI. The task
  // scope is the keystore, not an auth gate on every call.
  it('does not gate every read behind user authentication', () => {
    expect(code).not.toMatch(/setUserAuthenticationRequired/);
  });

  // A bare iv+ciphertext concat hard-codes a 12-byte IV. That is an
  // implementation default, not a platform contract, and a longer IV would
  // then decrypt to garbage -- a permanent loss of the device identity, on a
  // different device, with nothing to debug. Both lengths are stored, and the
  // read is the exact inverse of the write.
  it('length-prefixes the IV so a non-12-byte IV still round-trips', () => {
    const seal = store.slice(store.indexOf('private fun seal('));
    expect(seal).toMatch(/iv\.size ushr 8/);
    expect(seal).toMatch(/ct\.size ushr 8/);
    const open = store.slice(
      store.indexOf('private fun open('),
      store.indexOf('private fun secretKey('),
    );
    expect(open).toMatch(/raw\[0\]/);
    expect(open).toMatch(/raw\[1\]/);
    expect(open).toMatch(/raw\[2\]/);
    expect(open).toMatch(/raw\[3\]/);
    expect(open).toMatch(/raw\.size == 4 \+ ivLen \+ ctLen/);
    expect(open).toMatch(/GCMParameterSpec/);
  });

  // apply() is a fire-and-forget async write: a process death right after
  // start() loses a brand-new identity and the next launch re-pairs the device
  // as a new one. commit() is the whole difference.
  it('commits the write synchronously', () => {
    const set = store.slice(
      store.indexOf('override fun set('),
      store.indexOf('override fun remove('),
    );
    expect(set).toMatch(/\.commit\(\)/);
    expect(set).not.toMatch(/\.apply\(\)/);
  });

  // A read failure flattened to null reads as "first launch", which mints a
  // FRESH identity and silently re-pairs the device (R40(c)).
  it('rejects a read failure instead of resolving null', () => {
    const get = store.slice(
      store.indexOf('override fun get('),
      store.indexOf('override fun set('),
    );
    expect(get).toMatch(/promise\.reject\("E_KEYSTORE"/);
    expect(get).toMatch(/prefs\.getString\(key, null\)/);
  });

  // The key must never be exportable out of the keystore, or a copied prefs
  // file would carry the identity to another device.
  it('holds a non-exportable AndroidKeyStore key', () => {
    expect(store).toMatch(/KeyStore\.getInstance\("AndroidKeyStore"\)/);
    expect(store).toMatch(/PURPOSE_ENCRYPT or KeyProperties\.PURPOSE_DECRYPT/);
  });
});

describe('the iOS Keychain store', () => {
  const store = read(repo + 'modules/rn-securestore/ios/DaakSecureStore.swift');

  // AfterFirstUnlockThisDeviceOnly is the one accessibility class that is both
  // readable by the background accept loop and never restored to a second
  // device. A restored key would present one device id on two peers.
  it('uses AfterFirstUnlockThisDeviceOnly', () => {
    expect(store).toMatch(/kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly/);
    // Comments are stripped: the header comment NAMES the classes it rejects,
    // and a comment that documents a ban must not read as breaking it.
    const code = store
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n');
    expect(code).toMatch(/kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly/);
    expect(code).not.toMatch(/kSecAttrAccessibleAlways/);
  });

  // errSecItemNotFound is a first launch; every other OSStatus is a failure that
  // must reject, never resolve nil (R40(c)).
  it('treats not-found as a miss and every other status as a failure', () => {
    const get = store.slice(store.indexOf('func get('), store.indexOf('func set('));
    expect(get).toMatch(/case errSecItemNotFound:\s*resolve\(nil\)/);
    expect(get).toMatch(/reject\("E_KEYCHAIN"/);
  });

  // M3. A missing backslash is invisible at the call site and produces a
  // console line that reads `read failed for (key): (status)` -- which tells a
  // debugging reader nothing at the exact moment they need it. Pinned because
  // it is a one-character regression with no compiler signal in Swift.
  it('interpolates key and status in every reject message', () => {
    const messages = [...store.matchAll(/reject\("E_KEYCHAIN", "([^"]*)"/g)].map((m) => m[1]);
    expect(messages.length).toBeGreaterThan(0);
    for (const m of messages) {
      // A parenthesised token that is not preceded by a backslash is the bug.
      expect(m).not.toMatch(/(?<!\\)\((?:key|status|value|addStatus)\)/);
    }
    // And the ones that interpolate really do, at least once.
    expect(messages.some((m) => m.includes('\\(key)'))).toBe(true);
  });
});

describe('the engine start path owns the data dir and the keystore', () => {
  const android = read(repo + 'apps/mobile/android/app/src/main/java/dev/darshit/daak/DaakModule.kt');
  const ios = read(repo + 'apps/mobile/ios/Daak.swift');
  const androidStart = android.slice(
    android.indexOf('override fun start('),
    android.indexOf('override fun pairingBundle('),
  );
  const iosStart = ios.slice(ios.indexOf('func start('), ios.indexOf('func pairingBundle('));

  // R43: InProcessEngine.start() takes no arguments and hardcodes '' in
  // InProcess.ts, so the dir CANNOT come from JS. Resolving it natively is the
  // only way the invariant "the engine data dir is inside the app sandbox"
  // holds -- and an incoming dataDir is ignored outright rather than trusted,
  // because '' is what the frozen TS path actually sends.
  it('resolves the data dir natively on both platforms', () => {
    expect(androidStart).toMatch(/reactApplicationContext\.filesDir/);
    expect(iosStart).toMatch(/\.documentDirectory/);
  });

  it('constructs the engine with the OS-keystore constructor', () => {
    // Kotlin keeps the UDL name; Swift gets the STATIC FACTORY
    // `DaakEngine.newWithStore(store:sink:)`. uniffi 0.28.3 does NOT lower a
    // `[Name=...]` constructor to an init in Swift -- it is a static func on
    // the companion, and a bare `DaakEngine(store:sink:)` is a compile error.
    expect(android).toMatch(/DaakEngine\.newWithStore\(/);
    expect(ios).toMatch(/DaakEngine\.newWithStore\(store: KeychainSecureStore\(\), sink: self\)/);
  });

  // R40(c): a keystore failure must REJECT start. Falling back to the file
  // store would mint a new identity and re-pair the device silently.
  it('rejects start on a store failure, with no plaintext fallback', () => {
    expect(androidStart).toMatch(/promise\.reject\("E_ENGINE"/);
    expect(android).not.toMatch(/FileKeyStore|PersistentFileStore/);
    expect(iosStart).toMatch(/reject\("E_ENGINE"/);
    expect(ios).not.toMatch(/FileKeyStore|PersistentFileStore/);
  });
});

// The two stores above are the TurboModule faces. These are the ones the
// Rust engine actually calls, through the uniffi SecureStore callback, and they
// live in the APP target -- which cannot import the pod. They are separate
// files, so they need their own pins: a policy that only the module copy has is
// a policy the engine never runs under.
describe('the app-target uniffi SecureStore implementations', () => {
  const kt = read(
    repo + 'apps/mobile/android/app/src/main/java/dev/darshit/daak/KeystoreSecureStore.kt',
  );
  const swift = read(repo + 'apps/mobile/ios/Daak/KeychainSecureStore.swift');

  // The generated Kotlin protocol is `interface SecureStore` with un-prefixed
  // `get`/`set`/`delete`, and the generated Swift protocol is
  // `protocol SecureStore : AnyObject` with `throws`. Conforming to the wrong
  // name is a compile error, and a `throws` dropped from Swift is a silent
  // failure: the uniffi scaffolding calls `try?` and turns the throw into a
  // missing key, which is exactly the R40(c) identity-regeneration bug.
  it('conforms to the generated SecureStore protocol on both platforms', () => {
    expect(kt).toMatch(/: SecureStore\b/);
    expect(kt).toMatch(/override fun get\(key: String\): String\?/);
    expect(kt).toMatch(/override fun set\(key: String, value: String\)/);
    expect(kt).toMatch(/override fun delete\(key: String\)/);

    expect(swift).toMatch(/final class KeychainSecureStore: NSObject, SecureStore/);
    expect(swift).toMatch(/func get\(key: String\) throws -> String\?/);
    expect(swift).toMatch(/func set\(key: String, value: String\) throws/);
    expect(swift).toMatch(/func delete\(key: String\) throws/);
  });

  // The generated fielded error is `FfiStoreException.Store(reason)` in
  // Kotlin and `FfiStoreError.Store(reason:)` in Swift. Any other error type
  // would not be the one the uniffi callback scaffolding knows how to lower.
  //
  // `reason`, not `message`: uniffi 0.28.3 emits a fielded-error field as a
  // `val` on a kotlin.Exception subclass, so a field named `message` collides
  // with Throwable.message and the bindings do not compile at all. Pinned so
  // nobody "tidies" the name back.
  it('raises the generated fielded store error, not a flat one', () => {
    expect(kt).toMatch(/FfiStoreException\.Store\(/);
    expect(swift).toMatch(/FfiStoreError\.Store\(reason: /);
  });

  // The engine's identity: readable by the background accept loop, never
  // restored onto a second device, and never gated behind a biometric that no
  // background process could answer.
  it('keeps the same accessibility and auth policy as the module copies', () => {
    expect(swift).toMatch(/kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly/);
    expect(kt).toMatch(/setRandomizedEncryptionRequired\(true\)/);
    // Comments stripped: the header NAMES setUserAuthenticationRequired to
    // explain why it is not set, and that documentation must not read as a
    // violation of its own ban.
    const ktCode = kt
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n');
    expect(ktCode).not.toMatch(/setUserAuthenticationRequired/);
  });

  // M4. `set()` two methods above already checks the commit() boolean; delete()
  // threw the result away, so a storage failure was reported to Rust as a
  // successful delete while the old secret was still on disk. Nothing calls
  // delete today (the engine only reads and writes), so this is consistency
  // with a one-line hazard, not a live bug -- but the day key rotation uses it,
  // "deleted" would be a claim the disk disagrees with.
  it('checks the commit result in set AND delete', () => {
    const set = kt.slice(kt.indexOf('override fun set('), kt.indexOf('override fun delete('));
    const del = kt.slice(kt.indexOf('override fun delete('), kt.indexOf('private fun seal('));
    expect(set).toMatch(/check\(prefs\.edit\(\).*\.commit\(\)\)/);
    expect(del).toMatch(/check\(prefs\.edit\(\).*\.commit\(\)\)/);
  });
});

describe('fspaths reveal on Android', () => {
  const appManifest = read(repo + 'apps/mobile/android/app/src/main/AndroidManifest.xml');
  const kt = read(
    repo + 'modules/rn-fspaths/android/src/main/java/dev/darshit/daak/fspaths/DaakFsPathsModule.kt',
  );
  // An undeclared FileProvider authority throws IllegalArgumentException at
  // runtime, on the first reveal, with no build-time signal. Both halves are
  // pinned together here. The authority is FIXED rather than
  // applicationId-derived on purpose: modules/rn-share already declares the
  // applicationId-derived one, and two providers cannot share an authority.
  it('declares the provider authority the module uses', () => {
    const suffix = /const val AUTHORITY_SUFFIX = "([^"]+)"/.exec(kt)?.[1];
    expect(suffix).toBe('.fileprovider');
    // Derived from the application id, so a debug build with an id suffix
    // installs beside the stable app.
    expect(appManifest).toContain('android:authorities="${applicationId}.fileprovider"');
    expect(appManifest).toMatch(/androidx\.core\.content\.FileProvider/);
  });

  // The resource name in the manifest has to exist in a merged resource set.
  it('points the provider meta-data at a resource that exists', () => {
    const resource = /android:resource="@xml\/([^"]+)"/.exec(appManifest)?.[1];
    expect(resource).toBe('daak_fspaths_file_paths');
    expect(has(repo + 'modules/rn-fspaths/android/src/main/res/xml/' + resource + '.xml')).toBe(true);
  });

  // A file:// URI throws FileUriExposedException on API 24+, so the FileProvider
  // is not optional decoration.
  it('grants a read URI permission on the view intent', () => {
    expect(kt).toMatch(/FileProvider\.getUriForFile/);
    expect(kt).toMatch(/FLAG_GRANT_READ_URI_PERMISSION/);
  });

  // A literal "*/*" type makes the chooser list EVERY app that accepts any
  // file, so the user picks from a wall of unrelated apps. The intent type
  // must be DERIVED, not hardcoded. The content resolver answers on both
  // branches: FileProvider maps the file's extension, and a SAF provider reads
  // the document's stored type.
  it('opens the file with the document type, not a hardcoded wildcard', () => {
    const reveal = kt.slice(
      kt.indexOf('override fun reveal('),
      kt.indexOf('override fun exists('),
    );
    expect(reveal).not.toMatch(/setData(AndType)?\([^)]*"\*\/\*"/);
    // The derived type is applied on BOTH branches: the app-storage file and
    // the SAF document the download-folder move produced.
    expect(reveal.match(/typeFor\(uri\)/g)?.length).toBe(2);
    expect(kt).toContain('contentResolver.getType(');
  });

  // Package visibility: on API 30+ resolveActivity() answers null for an
  // intent filter the app has not declared a <queries> for, and startActivity
  // then throws ActivityNotFoundException. Reveal would resolve false on every
  // modern device -- a silent no-op that reads as "no file manager", which is
  // exactly the kind of false the R41 iOS no-op was supposed to be kept
  // distinct from.
  it('declares package visibility for the ACTION_VIEW it launches', () => {
    expect(appManifest).toMatch(/<queries>/);
    expect(appManifest).toMatch(/android\.intent\.action\.VIEW/);
    // The <queries> block must be inside <manifest>, not inside <application>:
    // the merger rejects it there.
    const manifestOpen = appManifest.indexOf('<manifest');
    const applicationOpen = appManifest.indexOf('<application');
    const queries = appManifest.indexOf('<queries>');
    expect(queries).toBeGreaterThan(manifestOpen);
    expect(queries).toBeLessThan(applicationOpen);
  });

  // R41: iOS reveal is a NO-OP and daak.folder stays withheld from the
  // installed category, so no UI path reaches a reveal that does not work.
  it('leaves iOS reveal a no-op and keeps daak.folder withheld', () => {
    const ios = read(repo + 'modules/rn-fspaths/ios/DaakFsPaths.swift');
    const reveal = ios.slice(ios.indexOf('func reveal('), ios.indexOf('func openFile('));
    expect(reveal).toMatch(/resolve\(false\)/);
    expect(reveal).not.toMatch(/QLPreviewController|UIFileSharingEnabled/);
    const notify = read(repo + 'packages/platform/src/notify.ts');
    expect(notify).toMatch(/DAK_REGISTERED_ACTIONS = \['daak\.open', 'daak\.share'\]/);
  });

  // There is no App Group on Android: the share extension is a separate
  // package with its own private filesDir, so returning filesDir would be a
  // lie about sharing. "" is the honest answer.
  it('answers the empty string for appGroupDir on Android, never filesDir', () => {
    const group = kt.slice(
      kt.indexOf('override fun appGroupDir('),
      kt.indexOf('override fun reveal('),
    );
    expect(group).toMatch(/resolve\(promise\) \{ "" \}/);
    expect(group).not.toMatch(/filesDir/);
  });
});

// C2. The Xcode project is objectVersion 54 with NO synchronized groups, so a
// .swift file on disk is compiled only if the pbxproj lists it. Adding a Swift
// file without the four pbxproj entries compiles fine everywhere else and then
// fails the app target with `cannot find 'X' in scope` -- and nothing in this
// repo, CI included, can see that without Xcode. So the file list on disk IS the
// contract, and it is checked here.
describe('every iOS app-target Swift file is in the Xcode project', () => {
  const iosDir = join(__dirname, repo, 'apps/mobile/ios/');
  const pbxproj = readFileSync(join(iosDir, 'Daak.xcodeproj/project.pbxproj'), 'utf8');

  // The Daak PBXGroup: the one whose children list is the app target's sources.
  const daakGroup = pbxproj.slice(
    pbxproj.indexOf('/* Daak */ = {'),
    pbxproj.indexOf('};', pbxproj.indexOf('/* Daak */ = {')),
  );

  // The app target's Sources phase. There are three in this project (app,
  // share extension, tests) and the FIRST one in the file is the test target's,
  // so the phase is located by the Daak.swift build-file id it must contain.
  // and NOT in target order, so it is found by the build-file id Daak.swift is
  // known to have, then walked BACK to the phase header that owns it. Taking
  // the first phase in the file picks the test target, which is how this check
  // would have gone vacuous.
  const daakSwiftBuildFile = /([0-9A-F]{24}) \/\* Daak\.swift in Sources \*\//.exec(pbxproj)![1];
  const phaseStart = pbxproj.lastIndexOf(
    'isa = PBXSourcesBuildPhase;',
    pbxproj.indexOf(daakSwiftBuildFile + ' /* Daak.swift in Sources */,'),
  );
  const sourcesPhase = pbxproj.slice(
    phaseStart,
    pbxproj.indexOf('runOnlyForDeploymentPostprocessing', phaseStart),
  );

  // If the project ever grows synchronized groups, a per-file listing stops
  // being necessary -- and this whole check would silently go vacuous. The
  // objectVersion in the header is the thing that decides that.
  it('still requires a per-file listing', () => {
    expect(pbxproj).toMatch(/objectVersion = 54;/);
    expect(pbxproj).not.toMatch(/fileSystemSynchronizedGroups/);
    // Both halves must be non-empty, or every assertion below passes vacuously.
    // DaakIntentBridge is a group child AND a Sources entry; Daak.swift is the
    // reverse (a Sources entry but not a group child), so the two sentinels
    // between them prove both slices really are the app target's.
    expect(daakGroup).toContain('DaakIntentBridge.swift');
    expect(sourcesPhase).toContain('Daak.swift in Sources');
    expect(sourcesPhase).not.toContain('DaakTests.m in Sources');
  });

  it('lists every Daak/*.swift file as a file reference, group child, build file and Sources entry', () => {
    const files = readdirSync(join(iosDir, 'Daak')).filter((n) => n.endsWith('.swift'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const quoted = f.replace('.', '\\.');
      // 1 of 4: the PBXFileReference, with the path the project actually uses.
      expect(pbxproj).toMatch(
        new RegExp(`isa = PBXFileReference;[^\\n]*name = ${quoted}; path = Daak/${quoted};`),
      );
      // 2 of 4: the PBXBuildFile that puts it in a build phase.
      expect(pbxproj).toMatch(
        new RegExp(`isa = PBXBuildFile; fileRef = [0-9A-F]{24} /\\* ${quoted} \\*/;`),
      );
      // 3 of 4: a child of the Daak group, or it is invisible in the IDE.
      expect(daakGroup).toMatch(new RegExp(`/\\* ${quoted} \\*/`));
      // 4 of 4: a SOURCES entry. This is the one that actually compiles it --
      // a build file for a resource or a framework would not link the symbol.
      expect(sourcesPhase).toMatch(new RegExp(`/\\* ${quoted} in Sources \\*/`));
    }
  });

  // A 24-hex id DEFINED twice is a dangling reference: Xcode keeps one
  // definition, and the other use can attach the WRONG file to the Sources
  // phase. Only definition lines count -- a PBXBuildFile legitimately appears in
  // both the PBXBuildFile section and a phase's file list.
  it('defines every object id exactly once', () => {
    const ids = [...pbxproj.matchAll(/^\t\t([0-9A-F]{24}) [^\n]*= \{/gm)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    const dupes = ids.filter((i) => (seen.has(i) ? true : (seen.add(i), false)));
    expect(dupes).toEqual([]);
  });
});

// I2. The engine's receive root is `<data_dir>/downloads`, and the data dir is
// resolved NATIVELY in the two start() implementations. fspaths is a SEPARATE
// TurboModule that never sees that dir, so it re-derives it -- and it used to
// derive the WRONG one: iOS returned bare Documents and Android returned the
// external app-specific Download/, neither of which is where anything is ever
// written. The result on Android is a file list that is empty for files that
// WERE received. These pins hold the three expressions to one answer per
// platform, so the surface cannot claim a directory the engine does not use.
describe('the fspaths module reports the directories the engine writes to', () => {
  const kt = read(
    repo +
      'modules/rn-fspaths/android/src/main/java/dev/darshit/daak/fspaths/DaakFsPathsModule.kt',
  );
  const swift = read(repo + 'modules/rn-fspaths/ios/DaakFsPaths.swift');
  const androidStart = read(
    repo + 'apps/mobile/android/app/src/main/java/dev/darshit/daak/DaakModule.kt',
  );
  const iosStart = read(repo + 'apps/mobile/ios/Daak.swift');

  // N1: androidStart/iosStart were READ but never asserted against, so this
  // suite pinned the fspaths half of a TWO-SIDED agreement and stayed silent
  // when the engine's real data dir drifted -- the exact bug I2 is about.
  // Both natives resolve the dir in start(); the fspaths module re-derives it.
  // Assert the ENGINE side here, so moving `daak` in either app native is red.
  it('resolves the SAME data dir in the engine start() that fspaths re-derives', () => {
    expect(androidStart).toMatch(/filesDir, "daak"/);
    expect(iosStart).toMatch(/appendingPathComponent\("daak"/);
    // And the roots the two sides agree on, so a change to either is visible.
    expect(kt).toMatch(/filesDir, "daak"/);
    expect(swift).toMatch(/appendingPathComponent\("daak"/);
  });

  // One helper per platform, and BOTH public methods route through it. Two
  // copies of the path expression is exactly how they drifted in the first
  // place.
  it('resolves the engine data dir once per platform, from the same root start() uses', () => {
    expect(kt).toMatch(/filesDir, "daak"/);
    expect(kt).toMatch(/private fun dataDir()/);
    expect(swift).toMatch(/appendingPathComponent\("daak"/);
    expect(swift).toMatch(/private static func dataDir\(\)/);
  });

  it('points downloadsDir at the engine receive root, not the platform Downloads dir', () => {
    // Android's whole failure mode: an external Download/ that is always empty.
    // Comments are stripped: the method's own doc comment NAMES the API it
    // rejects to explain the rejection, and that must not read as a violation.
    const ktCode = kt
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//'))
      .join('\n');
    expect(ktCode).not.toMatch(/getExternalFilesDir/);
    expect(kt).toMatch(/dataDir\(\), "downloads"/);
    // iOS: Documents/daak/downloads, the same subdirectory the engine makes.
    expect(swift).toMatch(/appendingPathComponent\("downloads"/);
    expect(swift).not.toMatch(/\.downloadsDirectory/);
  });

  it('points documentsDir at the data dir itself, one level above downloads', () => {
    expect(kt).toMatch(/override fun documentsDir\(promise: Promise\)[^\n]*dataDir\(\)/);
    expect(swift).toMatch(/resolve\(Self\.dataDir\(\)\.path\)/);
  });

  // The Rust side, quoted here so all three layers are checked in one place.
  it('still matches the engine out_dir the ffi start() builds', () => {
    const lib = read(repo + 'crates/daak-ffi/src/lib.rs');
    expect(lib).toMatch(/out_dir: dir\.join\("downloads"\)/);
  });
});

// I3. The plan's Produces list names FsPaths.exists and BOTH of its own native
// snippets define it; the implementation dropped it. The one caller the plan
// has in mind is the reveal UI (Task 10), which is not written yet -- so this
// is dead surface today, not a live bug. It is delivered because the plan asked
// for it and a later task would otherwise add a SECOND, differently-named
// exists() next to this module. The Spec, both natives and the platform wrapper
// must all carry it or the codegen contract breaks: a method on the Spec that a
// native class does not implement is an abstract-method compile error.
describe('fspaths exposes exists on the Spec and on both natives', () => {
  const spec = read(repo + 'modules/rn-fspaths/js/NativeDaakFsPaths.ts');
  const swift = read(repo + 'modules/rn-fspaths/ios/DaakFsPaths.swift');
  const kt = read(
    repo +
      'modules/rn-fspaths/android/src/main/java/dev/darshit/daak/fspaths/DaakFsPathsModule.kt',
  );
  const platform = read(repo + 'packages/platform/src/fspaths.ts');

  it('declares it on the TurboModule Spec', () => {
    expect(spec).toMatch(/exists\(path: string\): Promise<boolean>;/);
  });

  it('implements it on both platforms', () => {
    expect(swift).toMatch(/@objc func exists\(_ path: String/);
    expect(swift).toMatch(/fileExists\(atPath: path\)/);
    // The Android reveal already inlined File(path).exists(); exists() is that
    // same call exposed, which is why this must be a Spec method and not only a
    // private helper.
    expect(kt).toMatch(/override fun exists\(path: String, promise: Promise\)/);
  });

  it('is re-exported by the platform wrapper', () => {
    expect(platform).toMatch(/export async function exists\(path: string\): Promise<boolean>/);
    expect(platform).toMatch(/NativeDaakFsPaths\.exists\(path\)/);
  });
});

describe('fspaths exposes fileSizes on the Spec, on every native, and on the platform wrapper', () => {
  const spec = read(repo + 'modules/rn-fspaths/js/NativeDaakFsPaths.ts');
  const swiftIos = read(repo + 'modules/rn-fspaths/ios/DaakFsPaths.swift');
  const swiftMac = read(repo + 'modules/rn-fspaths/macos/DaakFsPaths.swift');
  const mmIos = read(repo + 'modules/rn-fspaths/ios/DaakFsPaths.mm');
  const mmMac = read(repo + 'modules/rn-fspaths/macos/DaakFsPaths.mm');
  const kt = read(
    repo +
      'modules/rn-fspaths/android/src/main/java/dev/darshit/daak/fspaths/DaakFsPathsModule.kt',
  );
  const platform = read(repo + 'packages/platform/src/fspaths.ts');

  it('declares it on the TurboModule Spec', () => {
    expect(spec).toMatch(/fileSizes\(paths: string\[\]\): Promise<\(number \| null\)\[\]>;/);
  });

  it('implements it on Android, iOS, and macOS', () => {
    expect(kt).toMatch(/override fun fileSizes\(paths: ReadableArray, promise: Promise\)/);
    expect(kt).toMatch(/pushNull\(\)/);
    for (const swift of [swiftIos, swiftMac]) {
      expect(swift).toMatch(/@objc func fileSizes\(_ paths: \[String\]/);
      expect(swift).toMatch(/\.typeRegular/);
      expect(swift).toMatch(/NSNull\(\)/);
    }
  });

  it('declares it in both .mm method tables', () => {
    expect(mmIos).toMatch(/RCT_EXTERN_METHOD\(fileSizes:\(NSArray<NSString \*> \*\)paths/);
    expect(mmMac).toMatch(/RCT_EXTERN_METHOD\(fileSizes:\(NSArray<NSString \*> \*\)paths/);
  });

  it('is re-exported by the platform wrapper', () => {
    expect(platform).toMatch(/export async function fileSizes\(paths: string\[\]\)/);
    expect(platform).toMatch(/NativeDaakFsPaths\.fileSizes\(paths\)/);
  });
});

describe('the modules are autolinked, not hand-registered', () => {
  // MainApplication adds only DaakPackage, the one module that lives in the
  // app. rn-share and rn-notify are autolinked through PackageList, so a manual
  // add() for the new ones would be a second, drift-prone copy of the same
  // registration.
  it('registers only DaakPackage in MainApplication', () => {
    const main = read(repo + 'apps/mobile/android/app/src/main/java/dev/darshit/daak/MainApplication.kt');
    expect(main).toMatch(/add\(DaakPackage\(\)\)/);
    expect(main).not.toMatch(
      /add\((DaakShare|DaakNotify|DaakClipboard|DaakFsPaths|DaakSecureStore)Package\(\)\)/,
    );
  });

  it('declares every module in the pnpm workspace', () => {
    expect(read(repo + 'pnpm-workspace.yaml')).toMatch(/- "modules\/\*"/);
    const lock = read(repo + 'pnpm-lock.yaml');
    for (const m of MODULES) expect(lock).toContain('modules/' + m.dir);
  });
});

describe('no module gained a send path', () => {
  // This task adds no send call site at all. A cheap tripwire on the rule that
  // cannot be verified without a build.
  const transport = /engine\.send|sendText|sendFiles|uniffi|DaakEngine|\bTCP\b|chacha|\.connect\(/;

  it('names no transport or crypto in the three new modules', () => {
    for (const m of ['rn-clipboard', 'rn-fspaths', 'rn-securestore']) {
      for (const source of sourcesUnder(repo + 'modules/' + m)) {
        expect(source).not.toMatch(transport);
      }
    }
  });
});

describe('rn-share present opens a file the download-folder move recorded', () => {
  const share = read(
    repo + 'modules/rn-share/android/src/main/java/dev/darshit/daak/share/DaakShareModule.kt',
  );

  // After the download-folder move the recorded path is a content:// document
  // URI. File(path) is not a file, so FileProvider.getUriForFile THROWS on it,
  // present() rejects, and the JS share verb swallows the rejection -- so the
  // Share button looks dead. An existing content:// path must pass through
  // unchanged; the read flag on the intent grants it to the receiver.
  it('passes an existing content:// path through unchanged', () => {
    expect(share).toContain('if (path.startsWith("content://")) {');
  });

  // The chooser filters on the intent type. The caller sends no type, and a
  // wildcard lists every app that accepts any file.
  it('takes the share type from the content resolver', () => {
    // The CODE SHAPE, not a bare substring: a comment cannot satisfy either
    // line, and a revert to the wildcard default breaks the second one.
    expect(share).toContain('val types = fileUris.map { ctx.contentResolver.getType(it) }.distinct()');
    expect(share).toContain(
      'val shareType = mime?.takeIf { it.isNotEmpty() } ?: types.singleOrNull() ?: "*/*"',
    );
  });

  // The picker was created, the delegate was retained with
  // objc_setAssociatedObject, and picker.delegate was NEVER assigned -- so the
  // callback never fired, the promise never settled, and the Send screen waited
  // forever with its button disabled. Retaining the delegate is not assigning
  // it.
  it('assigns the document picker delegate, so a chosen file is delivered', () => {
    const swift = read(repo + 'modules/rn-share/ios/DaakShare.swift');
    expect(swift).toContain('picker.delegate = delegate');
  });
});

describe('openFile opens a viewer on every platform', () => {
  const ios = read(repo + 'modules/rn-fspaths/ios/DaakFsPaths.swift');
  const mac = read(repo + 'modules/rn-fspaths/macos/DaakFsPaths.swift');
  const kt = read(
    repo + 'modules/rn-fspaths/android/src/main/java/dev/darshit/daak/fspaths/DaakFsPathsModule.kt',
  );

  it('previews with QuickLook on iOS and resolves false for an unreadable path', () => {
    const fn = ios.slice(ios.indexOf('func openFile('));
    expect(fn).toContain('QLPreviewController');
    expect(fn).toContain('isReadableFile');
    expect(fn).toMatch(/resolve\(false\)/);
    expect(ios).toContain('import QuickLook');
  });

  it('keeps the iOS bookmark scope open while the preview shows', () => {
    expect(ios).toContain('final class DaakPreviewSource');
    expect(ios).toMatch(/deinit \{[^}]*stopAccessingSecurityScopedResource/);
  });

  it('opens the default app on macOS', () => {
    const fn = mac.slice(mac.indexOf('func openFile('));
    expect(fn).toContain('NSWorkspace.shared.open(');
    expect(fn).toContain('fileExists(atPath: path)');
  });

  it('routes Android openFile through the same ACTION_VIEW path as reveal', () => {
    expect(kt).toMatch(/override fun openFile\(path: String, promise: Promise\) = reveal\(path, promise\)/);
  });

  it('declares openFile in both .mm tables and links QuickLook on iOS', () => {
    for (const p of ['ios/DaakFsPaths.mm', 'macos/DaakFsPaths.mm']) {
      expect(read(repo + 'modules/rn-fspaths/' + p)).toMatch(/RCT_EXTERN_METHOD\(openFile:/);
    }
    expect(read(repo + 'modules/rn-fspaths/DaakFsPaths.podspec')).toContain('s.ios.frameworks = "QuickLook"');
  });
});


describe('fspaths exposes the library methods on the Spec and on every native', () => {
  const spec = read(repo + 'modules/rn-fspaths/js/NativeDaakFsPaths.ts');
  const kt = read(
    repo + 'modules/rn-fspaths/android/src/main/java/dev/darshit/daak/fspaths/DaakFsPathsModule.kt',
  );
  const platform = read(repo + 'packages/platform/src/fspaths.ts');

  it('declares the three methods on the Spec', () => {
    // Task 11: the second array is required on the bridge. The facade always
    // sends it, with '' for a loose file, because an Objective-C selector has a
    // fixed argument list.
    expect(spec).toMatch(/saveToLibrary\(paths: string\[\], albums: string\[\]\): Promise<string\[\]>;/);
    expect(spec).toMatch(/moveReceivedFiles\(paths: string\[\], subdirs: string\[\]\): Promise<string\[\]>;/);
    expect(spec).toMatch(/requestPhotosAccess\(\): Promise<boolean>;/);
    expect(spec).toMatch(/photosAccessStatus\(\): Promise</);
  });

  it('implements them in Swift on iOS and macOS and in Kotlin', () => {
    for (const p of ['ios', 'macos']) {
      const swift = read(repo + 'modules/rn-fspaths/' + p + '/DaakFsPaths.swift');
      expect(swift).toMatch(/@objc func saveToLibrary\(_ paths: \[String\],\s+albums: \[String\],/);
      expect(swift).toMatch(/@objc func moveReceivedFiles\(_ paths: \[String\],\s+subdirs: \[String\],/);
      expect(swift).toMatch(/@objc func requestPhotosAccess\(/);
      expect(swift).toMatch(/@objc func photosAccessStatus\(/);
      const mm = read(repo + 'modules/rn-fspaths/' + p + '/DaakFsPaths.mm');
      expect(mm).toMatch(
        /RCT_EXTERN_METHOD\(saveToLibrary:\(NSArray<NSString \*> \*\)paths\s+albums:\(NSArray<NSString \*> \*\)albums\s+resolve:/,
      );
      expect(mm).toMatch(
        /RCT_EXTERN_METHOD\(moveReceivedFiles:\(NSArray<NSString \*> \*\)paths\s+subdirs:\(NSArray<NSString \*> \*\)subdirs\s+resolve:/,
      );
      expect(mm).toMatch(/RCT_EXTERN_METHOD\(requestPhotosAccess:/);
      expect(mm).toMatch(/RCT_EXTERN_METHOD\(photosAccessStatus:/);
    }
    expect(kt).toMatch(
      /override fun saveToLibrary\(paths: ReadableArray, albums: ReadableArray, promise: Promise\)/,
    );
    expect(kt).toMatch(
      /override fun moveReceivedFiles\(paths: ReadableArray, subdirs: ReadableArray, promise: Promise\)/,
    );
    expect(kt).toMatch(/override fun requestPhotosAccess\(promise: Promise\)/);
    expect(kt).toMatch(/override fun photosAccessStatus\(promise: Promise\)/);
  });

  it('is re-exported by the platform wrapper', () => {
    expect(platform).toMatch(/export async function saveToLibrary\(/);
    expect(platform).toMatch(/export async function requestPhotosAccess\(/);
    expect(platform).toMatch(/export async function photosAccessStatus\(/);
  });

  it('always sends one parallel entry for each path from the facade', () => {
    expect(platform).not.toContain('ParallelCall');
    expect(platform).not.toContain('withExtra');
    expect(platform).toMatch(/NativeDaakFsPaths\.moveReceivedFiles\(paths, parallel\(paths, subdirs\)\)/);
    expect(platform).toMatch(/NativeDaakFsPaths\.saveToLibrary\(paths, parallel\(paths, albums\)\)/);
  });
});

// Task 11: a received folder keeps its structure in the library and in the save
// folder. No native test target exists, so these pins hold the parts that fail
// in silence.
describe('native save and move keep the folder structure', () => {
  const strip = (s: string) =>
    s
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l))
      .join('\n');
  const kt = strip(
    read(repo + 'modules/rn-fspaths/android/src/main/java/dev/darshit/daak/fspaths/DaakFsPathsModule.kt'),
  );
  const ios = strip(read(repo + 'modules/rn-fspaths/ios/DaakFsPaths.swift'));
  const mac = strip(read(repo + 'modules/rn-fspaths/macos/DaakFsPaths.swift'));
  const from = (src: string, name: string) => {
    const at = src.indexOf(name);
    expect(at).toBeGreaterThan(-1);
    return src.slice(at);
  };

  it('puts an Android album below Pictures/Daak or Movies/Daak as a real nested path', () => {
    const fn = from(kt, 'private fun saveOne(');
    // JavaScript sends the album as `album / sub`. Android needs `album/sub`.
    expect(kt).toContain('.split(" / ")');
    expect(fn).toMatch(/RELATIVE_PATH, if \(dirs\.isEmpty\(\)\) "\$folder\/Daak" else "\$folder\/Daak\/\$dirs"\)/);
  });

  it('finds or creates each SAF directory of the subdir before the Android move', () => {
    const fn = from(kt, 'private fun safDir(');
    expect(fn).toContain('DocumentsContract.Document.MIME_TYPE_DIR');
    expect(fn).toContain('buildChildDocumentsUriUsingTree');
    expect(fn.indexOf('buildChildDocumentsUriUsingTree')).toBeLessThan(fn.indexOf('MIME_TYPE_DIR'));
  });

  it('refuses a subdir part that is empty, a dot, or two dots on every platform', () => {
    expect(kt).toMatch(/it\.isNotEmpty\(\) && it != "\." && it != "\.\."/);
    for (const swift of [ios, mac]) {
      expect(swift).toMatch(/!\$0\.isEmpty && \$0 != "\." && \$0 != "\.\."/);
    }
  });

  it('removes only the empty directories below the engine output directory', () => {
    for (const src of [kt, ios, mac]) {
      expect(src).toMatch(/func? pruneEmptyDirs\(/);
    }
    expect(from(kt, 'private fun pruneEmptyDirs(')).toMatch(/list\(\)\?\.isEmpty\(\) != true\) break/);
    for (const swift of [ios, mac]) {
      const rest = from(swift, 'func pruneEmptyDirs(');
      const fn = rest.slice(0, rest.indexOf('\n  }\n'));
      expect(fn).toContain('contentsOfDirectory(atPath:');
      expect(fn).toMatch(/\.isEmpty else \{ break \}/);
      // Review fix: removeItem deletes a folder and its files. rmdir(2) fails on
      // a folder that is not empty, so a file that arrives after the check stays.
      expect(fn).toMatch(/rmdir\(at\) == 0 else \{ break \}/);
      expect(fn).not.toContain('removeItem');
    }
  });

  it('answers the input path for a file that is already in its place on iOS and macOS', () => {
    for (const swift of [ios, mac]) {
      const fn = from(swift, 'func moveReceivedFiles(');
      expect(fn).not.toContain('samePath');
      // A file inside the save folder answers its own path. A file in the engine
      // output folder still moves, unless the save folder is that folder or below it.
      expect(fn).toMatch(/if srcAt\.hasPrefix\(folderAt\) && \(!srcAt\.hasPrefix\(outAt\) \|\| folderAt\.hasPrefix\(outAt\)\) \{\s*out\.append\(path\)\s*continue/);
    }
  });

  // User decision (Task 11): keep add-only access. Add-only access cannot read
  // albums, so each call makes a new album and adds its assets in the same
  // change block. A second call with the same title makes a second album.
  it('makes a new album and adds its assets in one change block on iOS, with add-only access', () => {
    const save = ios.slice(ios.indexOf('func saveToLibrary('), ios.indexOf('func requestPhotosAccess('));
    expect(save).toContain('creationRequestForAssetCollection(withTitle:');
    expect(save).toContain('placeholderForCreatedAsset');
    expect(save).toMatch(/addAssets\(placeholders as NSArray\)/);
    expect(save).not.toContain('fetchAssetCollections');
    expect(save).not.toContain('.readWrite');
    expect(ios).not.toContain('fetchAssetCollections');
  });
});

describe('markers do not reach file system calls', () => {
  const ios = read(repo + 'modules/rn-fspaths/ios/DaakFsPaths.swift');
  const kt = read(
    repo + 'modules/rn-fspaths/android/src/main/java/dev/darshit/daak/fspaths/DaakFsPaths' + 'Module.kt',
  );

  it('shows a Saved to Photos alert for a photos: marker on iOS', () => {
    const fn = ios.slice(ios.indexOf('func openFile('));
    expect(fn).toContain('path.hasPrefix("photos:")');
    expect(fn).toContain('UIAlertController');
    expect(fn).toContain('Saved to the Photos app');
    expect(fn).toContain('Open the Photos app to see it.');
    // D1: a second alert must not stack on the first.
    expect(fn).toMatch(/top is UIAlertController[\s\S]*resolve\(true\)[\s\S]*return/);
    // D2: UIKit refuses a present while the top controller moves.
    expect(fn).toMatch(/top\.isBeingPresented \|\| top\.isBeingDismissed[\s\S]*resolve\(false\)[\s\S]*return/);
    expect(fn).toContain('top.present(alert, animated: true) { resolve(true) }');
    // Apple documents no link to one asset, so no undocumented scheme is used.
    expect(ios).not.toContain('photos-redirect');
  });

  it('answers exists for markers without a file check', () => {
    expect(ios).toContain('if path.hasPrefix("photos:") { resolve(true); return }');
    expect(kt).toContain('path.startsWith("content://") || File(path).exists()');
  });
});

describe('iOS saves to the Photos library with add-only access', () => {
  const ios = read(repo + 'modules/rn-fspaths/ios/DaakFsPaths.swift');
  const plist = read(repo + 'apps/mobile/ios/Daak/Info.plist');

  it('imports PhotoKit and asks for add-only access', () => {
    expect(ios).toContain('import Photos');
    expect(ios).toContain('PHPhotoLibrary.requestAuthorization(for: .addOnly)');
    expect(ios).not.toContain('.readWrite');
  });

  it('never prompts from saveToLibrary', () => {
    const fn = ios.slice(ios.indexOf('func saveToLibrary('), ios.indexOf('func requestPhotosAccess('));
    expect(fn).not.toContain('requestAuthorization');
    expect(fn).toContain('authorizationStatus(for: .addOnly)');
  });

  it('deletes the source only after the add succeeded', () => {
    const start = ios.indexOf('func addToLibrary(');
    const fn = ios.slice(start, ios.indexOf('\n  }\n', start));
    const add = fn.indexOf('performChangesAndWait');
    const guardAt = fn.indexOf('guard let identifier');
    const remove = fn.indexOf('removeItem');
    expect(add).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(add);
    expect(remove).toBeGreaterThan(guardAt);
  });

  it('logs a source that could not be removed after the add', () => {
    const start = ios.indexOf('func addToLibrary(');
    const fn = ios.slice(start, ios.indexOf('\n  }\n', start));
    expect(fn).not.toContain('try? FileManager.default.removeItem');
    expect(fn).toMatch(/do \{ try FileManager\.default\.removeItem\(at: url\) \} catch \{\s*NSLog\("Daak: the saved photo's source file was not removed \(\\\(\(error as NSError\)\.domain\) \\\(\(error as NSError\)\.code\)\)"\)/);
    expect(fn).not.toContain('\\(error)');
    expect(fn).toContain('return "photos:" + identifier');
  });

  it('says in a comment that a second call makes a second album with the same name', () => {
    const save = ios.slice(ios.indexOf('func saveToLibrary('), ios.indexOf('func requestPhotosAccess('));
    expect(save).toMatch(/second album with the same name/);
  });

  it('declares the add-only usage description', () => {
    expect(plist).toContain('<key>NSPhotoLibraryAddUsageDescription</key>');
    expect(plist).not.toContain('NSPhotoLibraryUsageDescription');
  });
});

describe('Android saves to MediaStore without a permission', () => {
  const kt = read(
    repo + 'modules/rn-fspaths/android/src/main/java/dev/darshit/daak/fspaths/DaakFsPathsModule.kt',
  );
  const manifest = read(repo + 'apps/mobile/android/app/src/main/AndroidManifest.xml');

  it('skips API levels below 29', () => {
    expect(kt).toContain('Build.VERSION.SDK_INT < Build.VERSION_CODES.Q');
  });

  it('writes pending, then clears the pending flag, then deletes the source', () => {
    const fn = kt.slice(kt.indexOf('private fun saveOne('));
    const pending = fn.indexOf('IS_PENDING, 1');
    const clear = fn.indexOf('IS_PENDING, 0');
    const del = fn.indexOf('src.delete()');
    expect(pending).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(pending);
    expect(del).toBeGreaterThan(clear);
  });

  it('logs a source that could not be deleted and still returns the URI', () => {
    const fn = kt.slice(kt.indexOf('private fun saveOne('));
    const del = fn.indexOf('if (!src.delete())');
    expect(del).toBeGreaterThan(fn.indexOf('IS_PENDING, 0'));
    expect(fn).toContain('android.util.Log.w("DaakFsPaths", "saved item but could not delete source")');
    expect(fn).not.toContain('${src.name}');
    expect(fn.indexOf('uri.toString()')).toBeGreaterThan(del);
  });

  it('removes the half-made row when the copy fails', () => {
    const fn = kt.slice(kt.indexOf('private fun saveOne('));
    const catchAt = fn.indexOf('catch');
    expect(catchAt).toBeGreaterThan(-1);
    expect(fn.indexOf('resolver.delete(uri, null, null)')).toBeGreaterThan(catchAt);
  });

  it('checks the row count of the pending-clear update before it deletes the source', () => {
    const fn = kt.slice(kt.indexOf('private fun saveOne('));
    const clear = fn.indexOf('IS_PENDING, 0');
    const check = fn.indexOf('!= 1', clear);
    const thrown = fn.indexOf('IllegalStateException("pending not cleared")', clear);
    const del = fn.indexOf('src.delete()');
    expect(check).toBeGreaterThan(clear);
    expect(thrown).toBeGreaterThan(check);
    expect(del).toBeGreaterThan(thrown);
  });

  it('answers once for each input, also for a null entry', () => {
    const fn = kt.slice(kt.indexOf('override fun saveToLibrary('), kt.indexOf('override fun requestPhotosAccess('));
    expect(fn).not.toContain('mapNotNull');
    expect(fn).toContain('paths.getString(it) ?: ""');
  });

  it('adds no storage permission', () => {
    expect(manifest).not.toContain('WRITE_EXTERNAL_STORAGE');
    expect(manifest).not.toContain('READ_MEDIA_IMAGES');
    expect(manifest).not.toContain('READ_MEDIA_VIDEO');
    expect(manifest).not.toContain('READ_MEDIA_AUDIO');
  });
});

// Folder send on iOS (Task 7). The picked folder is outside the sandbox, and its
// security scope closes. So pickFolder copies the tree into the app cache, and
// the engine sends from that copy. No iOS unit-test target exists, so these pins
// hold the parts that fail in silence: a copy that loads a whole file into
// memory, a symlink that escapes the tree, and a delete outside the cache.
describe('iOS folder pick, copy, and stats', () => {
  const strip = (s: string) =>
    s
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l))
      .join('\n');
  const share = strip(read(repo + 'modules/rn-share/ios/DaakShare.swift'));
  const shareMm = read(repo + 'modules/rn-share/ios/DaakShare.mm');
  const fs = strip(read(repo + 'modules/rn-fspaths/ios/DaakFsPaths.swift'));
  const fsMm = read(repo + 'modules/rn-fspaths/ios/DaakFsPaths.mm');
  // From the function name to the next member at the same indent.
  const body = (src: string, name: string): string => {
    const at = src.indexOf(name);
    expect(at).toBeGreaterThan(-1);
    const rest = src.slice(at);
    const next = rest.slice(1).search(/\n  (@objc )?(private )?(static )?func |\n}\n/);
    return next === -1 ? rest : rest.slice(0, next + 1);
  };

  it('declares pickFolder in Swift and in the .mm table', () => {
    expect(share).toMatch(/@objc func pickFolder\(_ resolve: @escaping RCTPromiseResolveBlock/);
    expect(shareMm).toMatch(/RCT_EXTERN_METHOD\(pickFolder:\(RCTPromiseResolveBlock\)resolve/);
  });

  it('opens a folder picker and assigns its delegate', () => {
    const pick = body(share, '@objc func pickFolder');
    expect(pick).toContain('UIDocumentPickerViewController(forOpeningContentTypes: [.folder])');
    expect(pick).toMatch(/picker\.delegate = delegate/);
  });

  it('opens the security scope for the copy and closes it in a defer', () => {
    const copy = body(share, 'static func copyPickedFolder');
    const open = copy.indexOf('startAccessingSecurityScopedResource()');
    expect(open).toBeGreaterThan(-1);
    expect(copy).toMatch(/defer \{[^}]*stopAccessingSecurityScopedResource\(\)/);
  });

  it('copies into <caches>/daak-send/<uuid>/<folder name>, file by file, with no file in memory', () => {
    expect(share).toMatch(/\.cachesDirectory/);
    expect(share).toContain('"daak-send"');
    const copy = body(share, 'static func copyPickedFolder');
    expect(copy).toContain('UUID().uuidString');
    expect(copy).toContain('lastPathComponent');
    expect(copy).toMatch(/copyItem\(at:/);
    expect(share).not.toMatch(/Data\(contentsOf: (e|entry|file|src)/);
    expect(share).not.toMatch(/copyItem\(at: folder/);
  });

  it('skips symlinks in the copy walk', () => {
    expect(body(share, 'static func listTree')).toMatch(/isSymbolicLink == true \{ continue \}/);
  });

  it('rejects NO_SPACE:<bytes> below size x 1.1 and EMPTY for a tree with no file', () => {
    expect(share).toContain('volumeAvailableCapacityForImportantUsage');
    expect(share).toMatch(/\* 1\.1/);
    expect(share).toContain('"NO_SPACE:\\(');
    expect(share).toMatch(/reject\("EMPTY", "EMPTY"/);
  });

  // An iCloud Drive file that is not on the device is a hidden placeholder,
  // `.<name>.icloud`. A copy of it sends the placeholder, not the file, with no
  // error. The listing refuses the whole pick before any copy starts.
  it('refuses the pick with NOT_DOWNLOADED for an iCloud placeholder, before any copy', () => {
    const list = body(share, 'static func listTree');
    expect(list).toContain('isICloudPlaceholder(');
    expect(list.indexOf('isICloudPlaceholder(')).toBeLessThan(list.indexOf('isSymbolicLink == true'));
    expect(list).toMatch(/throw FolderCopyError\.notDownloaded/);
    expect(share).toContain('"^\\.(.+)\\.icloud$"');
    expect(share).toMatch(/reject\("NOT_DOWNLOADED", "NOT_DOWNLOADED"/);
    // The listing runs before the space check and before the first folder is made.
    const copy = body(share, 'static func copyPickedFolder');
    expect(copy.indexOf('listTree(')).toBeLessThan(copy.indexOf('volumeAvailableCapacityForImportantUsage'));
    expect(copy.indexOf('listTree(')).toBeLessThan(copy.indexOf('createDirectory('));
  });

  it('deletes the partial copy on any failure', () => {
    const copy = body(share, 'static func copyPickedFolder');
    expect(copy).toMatch(/catch \{\s*try\? fm\.removeItem\(at: slot\)\s*throw error/);
  });

  it('copies off the main thread', () => {
    expect(share).toMatch(/DispatchQueue\.global\([^)]*\)\.async \{[\s\S]*copyPickedFolder/);
  });

  it('declares the three fspaths methods in Swift and in the .mm table', () => {
    expect(fs).toMatch(/@objc func folderStats\(_ path: String/);
    expect(fs).toMatch(/@objc func discardPickedCopy\(_ path: String/);
    expect(fs).toMatch(/@objc func sweepPickedCopies\(_ resolve: @escaping RCTPromiseResolveBlock/);
    expect(fsMm).toMatch(/RCT_EXTERN_METHOD\(folderStats:\(NSString \*\)path/);
    expect(fsMm).toMatch(/RCT_EXTERN_METHOD\(discardPickedCopy:\(NSString \*\)path/);
    expect(fsMm).toMatch(/RCT_EXTERN_METHOD\(sweepPickedCopies:\(RCTPromiseResolveBlock\)resolve/);
  });

  it('folderStats skips symlinks, has an error handler, and answers NSNull for an unreadable root', () => {
    const stats = body(fs, '@objc func folderStats');
    expect(stats).toContain('errorHandler');
    expect(stats).toContain('isSymbolicLink');
    expect(stats).toContain('NSNull()');
    expect(stats).toContain('DispatchQueue.global');
  });

  it('discardPickedCopy resolves symlinks and .. BEFORE the daak-send prefix check, and refuses the rest', () => {
    const discard = body(fs, '@objc func discardPickedCopy');
    const resolveAt = discard.indexOf('resolvingSymlinksInPath()');
    const standardAt = discard.indexOf('standardizedFileURL');
    const prefixAt = discard.indexOf('hasPrefix(');
    expect(resolveAt).toBeGreaterThan(-1);
    expect(standardAt).toBeGreaterThan(-1);
    expect(prefixAt).toBeGreaterThan(resolveAt);
    expect(prefixAt).toBeGreaterThan(standardAt);
    expect(discard).toMatch(/reject\("E_NOT_PICKED_COPY"/);
    expect(fs).toContain('"daak-send"');
  });

  it('sweepPickedCopies deletes under daak-send only, and keeps a copy that a pick makes during the sweep', () => {
    const sweep = body(fs, '@objc func sweepPickedCopies');
    expect(sweep).toContain('pickedCopiesRoot()');
    expect(sweep).toContain('creationDate');
    expect(sweep).toMatch(/removeItem\(at: slot\)/);
  });
});

// Folder send on Android (Task 8). SAF gives a content:// tree, not a path, and
// the engine reads with std::fs. So pickFolder copies the tree into the app
// cache, the same as iOS. No JVM test source set exists, so these pins hold the
// parts that fail in silence: a copy that loads a whole file into memory, a
// display name that escapes the slot, and a delete outside the cache.
describe('Android folder pick, copy, and stats', () => {
  const strip = (s: string) =>
    s
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l))
      .join('\n');
  const share = strip(
    read(repo + 'modules/rn-share/android/src/main/java/dev/darshit/daak/share/DaakShareModule.kt'),
  );
  const fs = strip(
    read(
      repo +
        'modules/rn-fspaths/android/src/main/java/dev/darshit/daak/fspaths/DaakFsPathsModule.kt',
    ),
  );
  const shareSpec = read(repo + 'modules/rn-share/js/NativeDaakShare.ts');
  const fsSpec = read(repo + 'modules/rn-fspaths/js/NativeDaakFsPaths.ts');
  // From the function name to the next member at the same indent.
  const body = (src: string, name: string): string => {
    const at = src.indexOf(name);
    expect(at).toBeGreaterThan(-1);
    const rest = src.slice(at);
    const next = rest
      .slice(1)
      .search(/\n  (@ReactMethod\n  )?(override |private )?(inline )?fun |\n}\n/);
    return next === -1 ? rest : rest.slice(0, next + 1);
  };

  // A required Spec method is abstract in the generated Java spec. A Kotlin
  // module without the override then fails the Gradle build.
  it('makes the four folder methods required in both Specs', () => {
    expect(shareSpec).toMatch(/^ {2}pickFolder\(\): Promise<string \| null>;/m);
    expect(fsSpec).toMatch(/^ {2}folderStats\(path: string\)/m);
    expect(fsSpec).toMatch(/^ {2}discardPickedCopy\(path: string\): Promise<void>;/m);
    expect(fsSpec).toMatch(/^ {2}sweepPickedCopies\(\): Promise<void>;/m);
    expect(shareSpec + fsSpec).not.toMatch(/(pickFolder|folderStats|PickedCopy|PickedCopies)\?\(/);
  });

  it.each([
    ['rn-share', shareSpec, share],
    ['rn-fspaths', fsSpec, fs],
  ])('%s: the Kotlin module overrides every Spec method', (_name, spec, kt) => {
    const methods = [...spec.matchAll(/^ {2}([a-zA-Z]\w*)\??\([^)]*\)\s*:/gm)].map((m) => m[1]);
    expect(methods.length).toBeGreaterThan(3);
    for (const m of methods) expect(kt).toMatch(new RegExp(`override fun ${m}\\(`));
  });

  it('opens ACTION_OPEN_DOCUMENT_TREE with its own request code', () => {
    const pick = body(share, 'override fun pickFolder(promise: Promise)');
    expect(pick).toContain('Intent.ACTION_OPEN_DOCUMENT_TREE');
    expect(pick).toContain('PICK_FOLDER');
    expect(share).toMatch(/PICK_FOLDER = \d+/);
  });

  it('resolves null on cancel and copies off the main thread', () => {
    const result = body(share, 'override fun onActivityResult(');
    expect(result).toContain('PICK_FOLDER');
    expect(result).toMatch(/resolve\(null\)/);
    expect(result).toMatch(/thread\([^)]*\) \{[\s\S]*copyPickedFolder\(/);
  });

  it('copies into <cacheDir>/daak-send/<uuid>/<folder name>, file by file, with no file in memory', () => {
    const copy = body(share, 'private fun copyPickedFolder(');
    expect(copy).toContain('ctx.cacheDir');
    expect(copy).toContain('"daak-send"');
    expect(copy).toContain('UUID.randomUUID()');
    expect(copy).toContain('openInputStream(');
    expect(copy).toContain('copyTo(');
    expect(share).not.toMatch(/readBytes\(\)|readText\(\)/);
  });

  it('walks the tree with DocumentsContract and refuses a name that leaves the slot', () => {
    const list = body(share, 'private fun listTree(');
    expect(list).toContain('DocumentsContract.buildChildDocumentsUriUsingTree(');
    expect(list).toContain('Document.MIME_TYPE_DIR');
    expect(list).toContain('safeName(');
    const safe = body(share, 'private fun safeName(');
    expect(safe).toContain('"."');
    expect(safe).toContain('".."');
    expect(safe).toContain("'/'");
  });

  it('lists, then checks EMPTY, then checks the space, and only then writes', () => {
    const copy = body(share, 'private fun copyPickedFolder(');
    const list = copy.indexOf('listTree(');
    const empty = copy.indexOf('FolderPickError("EMPTY"');
    const space = copy.indexOf('StatFs(');
    const write = copy.indexOf('mkdirs()');
    expect(list).toBeGreaterThan(-1);
    expect(empty).toBeGreaterThan(list);
    expect(space).toBeGreaterThan(empty);
    expect(write).toBeGreaterThan(space);
    expect(copy).toContain('availableBytes');
    expect(copy).toMatch(/\* 1\.1/);
    expect(copy).toContain('"NO_SPACE:$needed"');
  });

  it('rejects with the codes the facade reads', () => {
    expect(share).toMatch(/reject\(e\.code, e\.message\)/);
    expect(share).toMatch(/FolderPickError\("NO_SPACE"/);
    expect(share).toMatch(/FolderPickError\("EMPTY", "EMPTY"\)/);
    expect(share).toMatch(/reject\("E_COPY"/);
  });

  it('deletes the partial copy on any failure', () => {
    const copy = body(share, 'private fun copyPickedFolder(');
    expect(copy).toMatch(/catch \(t: Throwable\) \{\s*slot\.deleteRecursively\(\)\s*throw t/);
  });

  it('folderStats walks off the main thread, skips symlinks, and answers null for an unreadable tree', () => {
    const stats = body(fs, 'override fun folderStats(');
    expect(stats).toMatch(/thread\(/);
    expect(stats).toContain('Files.isSymbolicLink(');
    expect(stats).toContain('resolve(null)');
    expect(stats).toContain('listFiles()');
    expect(stats).toContain('putDouble("files"');
    expect(stats).toContain('putDouble("bytes"');
  });

  it('discardPickedCopy canonicalises BEFORE a component check under daak-send, and refuses the rest', () => {
    const discard = body(fs, 'override fun discardPickedCopy(');
    const canon = discard.indexOf('canonicalFile');
    const check = discard.indexOf('.startsWith(root)');
    expect(canon).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(canon);
    // Path.startsWith compares whole components: daak-sendX is not under daak-send.
    expect(discard).toContain('toPath()');
    expect(discard).toMatch(/reject\("E_NOT_PICKED_COPY"/);
    expect(fs).toContain('"daak-send"');
  });

  it('sweepPickedCopies keeps a slot that a pick makes during the sweep', () => {
    const sweep = body(fs, 'override fun sweepPickedCopies(');
    const started = sweep.indexOf('val started = System.currentTimeMillis()');
    const worker = sweep.indexOf('thread(');
    expect(started).toBeGreaterThan(-1);
    expect(worker).toBeGreaterThan(started);
    expect(sweep).toMatch(/lastModified\(\) >= started\) continue/);
    expect(sweep).toContain('pickedCopiesRoot()');
    expect(sweep).toContain('deleteRecursively()');
  });
});

// Cleanup C: small findings from the folder send and receive reviews.
describe('cleanup C native pins', () => {
  const strip = (s: string) =>
    s
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l))
      .join('\n');
  const mac = strip(read(repo + 'modules/rn-fspaths/macos/DaakFsPaths.swift'));
  const ios = strip(read(repo + 'modules/rn-fspaths/ios/DaakFsPaths.swift'));
  const kt = strip(
    read(
      repo +
        'modules/rn-fspaths/android/src/main/java/dev/darshit/daak/fspaths/DaakFsPathsModule.kt',
    ),
  );
  const share = strip(
    read(repo + 'modules/rn-share/android/src/main/java/dev/darshit/daak/share/DaakShareModule.kt'),
  );
  const fsSpec = read(repo + 'modules/rn-fspaths/js/NativeDaakFsPaths.ts');
  const from = (src: string, name: string): string => {
    const at = src.indexOf(name);
    expect(at).toBeGreaterThan(-1);
    return src.slice(at);
  };

  it('prunes empty folders on a best-effort basis, so a throw never rejects the moves', () => {
    for (const name of ['override fun moveReceivedFiles(', 'override fun saveToLibrary(']) {
      const fn = from(kt, name).split('\n  @ReactMethod')[0];
      expect(fn).toMatch(/runCatching \{ pruneEmptyDirs\(input\) \}/);
      expect(fn).toContain('Log.w(');
      expect(fn.indexOf('runCatching')).toBeGreaterThan(fn.indexOf('val out'));
      expect(fn.indexOf('runCatching')).toBeLessThan(fn.indexOf('writable(out)'));
    }
  });

  it('fails the pick when a second folder has the same name', () => {
    const copy = from(share, 'private fun copyPickedFolder').split('\n  private fun listTree')[0];
    const dirBranch = copy.slice(copy.indexOf('if (entry.isDir) {'), copy.indexOf('continue'));
    expect(dirBranch).toMatch(/if \(target\.exists\(\)\) throw (FolderPickError|IOException)/);
    expect(dirBranch).not.toContain('!target.isDirectory');
    expect(dirBranch).toContain('mkdirs()');
  });

  it.each([
    ['macOS', mac],
    ['iOS', ios],
  ])('%s folderStats answers NSNull when the root cannot be read', (_n, src) => {
    const fn = from(src, '@objc func folderStats').split('\n  /// ')[0];
    expect(fn).toContain('contentsOfDirectory(atPath:');
    expect(fn).toContain('errorHandler');
    expect(fn).toMatch(/unreadable = true/);
    expect(fn.indexOf('contentsOfDirectory(atPath:')).toBeLessThan(fn.indexOf('enumerator('));
    expect(fn).toMatch(/if unreadable \{\s*resolve\(NSNull\(\)\)/);
  });

  it('says that iOS always makes a new album', () => {
    expect(fsSpec).not.toContain('finds or creates');
    expect(fsSpec).toMatch(/iOS makes a new Photos[\s*]+album/);
  });

  it('logs a failed folder make on macOS, as iOS does', () => {
    const move = from(mac, '@objc func moveReceivedFiles');
    const at = move.indexOf('createDirectory(at: target');
    const catchAt = move.indexOf('catch', at);
    const line = move.slice(catchAt).split('\n')[1];
    expect(line).toMatch(/NSLog\("Daak: could not make a folder/);
    expect(line).not.toMatch(/\.path|\bpath\b/);
  });
});

// Task 19: with no chosen folder, Android documents go to Download/Daak. No
// Kotlin test target exists, so these are source-text pins in the style of the
// tests above. They cannot run the Kotlin code.
describe('Android documents go to Download/Daak when no folder is chosen', () => {
  const strip = (s: string) =>
    s
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\/?\*)/.test(l))
      .join('\n');
  const kt = strip(
    read(repo + 'modules/rn-fspaths/android/src/main/java/dev/darshit/daak/fspaths/DaakFsPathsModule.kt'),
  );
  const from = (name: string) => {
    const at = kt.indexOf(name);
    expect(at).toBeGreaterThan(-1);
    return kt.slice(at);
  };

  it('a user with no chosen folder gets Download/Daak', () => {
    const name = from('override fun downloadFolderName(');
    const body = name.slice(0, name.indexOf('override fun clearDownloadFolder('));
    expect(kt).toContain('const val DEFAULT_FOLDER = "Download/Daak"');
    expect(body).toMatch(/Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.Q/);
    expect(body).toContain('DEFAULT_FOLDER');
    const move = from('override fun moveReceivedFiles(');
    expect(move.indexOf('saveDocuments(')).toBeGreaterThan(move.indexOf('treeUri == null'));
    const doc = from('private fun saveDocument(');
    expect(doc).toContain('MediaStore.Downloads.EXTERNAL_CONTENT_URI');
    expect(doc).toMatch(/RELATIVE_PATH, if \(dirs\.isEmpty\(\)\) DEFAULT_FOLDER else "\$DEFAULT_FOLDER\/\$dirs"\)/);
    expect(doc).toContain('if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return path');
  });

  it('a user with a chosen folder keeps it', () => {
    const name = from('override fun downloadFolderName(');
    const body = name.slice(0, name.indexOf('override fun clearDownloadFolder('));
    expect(body).toContain('prefs().getString(KEY_TREE, null) ?: prefs().getString(KEY_NAME, null)');
    // The default is only for a call with no saved tree.
    const move = from('override fun moveReceivedFiles(');
    const head = move.slice(0, move.indexOf('val resolver'));
    expect(head).toMatch(
      /if \(treeUri == null\) \{[\s\S]*SDK_INT < Build\.VERSION_CODES\.Q\) return@resolve writable\(input\)/,
    );
    expect(head).toContain('saveDocuments(');
  });

  it('a quarantined item is never relocated', () => {
    const doc = from('private fun saveDocument(');
    expect(doc).toContain('isQuarantined(src)');
    const q = from('private fun isQuarantined(');
    expect(q).toContain('File(dataDir(), "downloads/quarantine")');
    expect(q).toContain('startsWith(');
  });

  it('a hostile name (.., 300 characters, a control character) is cleaned before the MediaStore insert', () => {
    const doc = from('private fun saveDocument(');
    expect(doc.indexOf('cleanName(')).toBeGreaterThan(-1);
    expect(doc.indexOf('cleanName(')).toBeLessThan(doc.indexOf('resolver.insert('));
    expect(doc).toContain('safeParts(subdir.split("/"))');
    const clean = from('private fun cleanName(');
    const body = clean.slice(0, clean.indexOf('private fun saveDocument('));
    expect(body).toMatch(/isISOControl/);
    expect(body).toContain("'\\\\'");
    expect(body).toMatch(/== "\.\."/);
    expect(body).toMatch(/MAX_NAME/);
    expect(kt).toMatch(/const val MAX_NAME = \d+/);
  });

  it('a non-media file keeps application/octet-stream', () => {
    const doc = from('private fun saveDocument(');
    expect(doc).toContain('val mime = guessMime(src.name)');
    expect(doc).toMatch(/mime\.startsWith\("image\/"\) \|\| mime\.startsWith\("video\/"\)\) return path/);
    expect(doc).toContain('MediaStore.MediaColumns.MIME_TYPE, mime');
    expect(kt).toContain('else -> "application/octet-stream"');
  });

  it('writes pending, clears it, requires 1 row, then deletes the source or the row', () => {
    const doc = from('private fun saveDocument(');
    const pending = doc.indexOf('IS_PENDING, 1');
    const clear = doc.indexOf('IS_PENDING, 0');
    const check = doc.indexOf('updated != 1', clear);
    const del = doc.indexOf('src.delete()');
    expect(pending).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(pending);
    expect(check).toBeGreaterThan(clear);
    expect(del).toBeGreaterThan(check);
    expect(doc.indexOf('resolver.delete(uri, null, null)')).toBeGreaterThan(doc.indexOf('catch'));
  });
});
