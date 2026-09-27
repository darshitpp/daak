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
    expect(gradle).toMatch(/minSdkVersion 24/);
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
      store.indexOf('override fun delete('),
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

  // The generated fielded error is `FfiStoreException.Store(message)` in
  // Kotlin and `FfiStoreError.Store(message:)` in Swift. Any other error type
  // would not be the one the uniffi callback scaffolding knows how to lower.
  it('raises the generated fielded store error, not a flat one', () => {
    expect(kt).toMatch(/FfiStoreException\.Store\(/);
    expect(swift).toMatch(/FfiStoreError\.Store\(message: /);
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
