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
    const authority = /const val AUTHORITY = "([^"]+)"/.exec(kt)?.[1];
    expect(authority).toBe('dev.darshit.daak.fileprovider');
    expect(appManifest).toContain('android:authorities="dev.darshit.daak.fileprovider"');
    expect(appManifest).toMatch(/androidx\.core\.content\.FileProvider/);
    // The two providers must not collide, or the manifest merger fails the build.
    expect(appManifest.split('${').join('DOLLAR')).not.toMatch(
      /android:authorities="DOLLAR\{applicationId\}/,
    );
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
    const reveal = ios.slice(ios.indexOf('func reveal('));
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
