import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

// On 2026-10-01 the iOS app launched and rendered, then threw:
//
//   Invariant Violation: TurboModuleRegistry.getEnforcing(...): 'DaakBgSched'
//   could not be found.
//
// iosAutolinking.test.ts already proves every podspec is FOUND and resolved to.
// That is necessary and it was not sufficient: all seven podspecs declare
//
//   s.source_files = "ios/**/*.{swift,mm,h}"
//
// but CocoaPods sets PODS_TARGET_SRCROOT to the podspec's OWN directory, which
// is already modules/rn-<mod>/ios (react-native.config.js points podspecPath at
// ios/Daak*.podspec). So the glob resolves to modules/rn-<mod>/ios/ios/** -- a
// directory that does not exist. Every one of the seven pods compiled ZERO
// sources and produced an EMPTY libDaak*.a, which is why the dylib's only
// DaakBgSched symbols came from libReactCodegen.a (the generated spec) and
// there was no DaakBgSched class at all. Registration was never the problem:
// there was nothing to register.
//
// This asserts the glob against real filenames. Asserting on the literal
// string "ios/**" would pass forever, which is exactly what the existing
// iosAutolinking.test.ts ":ios"/"ios/**" check did -- it green-lit the string
// that turned out to BE the bug. The only honest check is whether the pattern
// matches files.
const repoRoot = join(__dirname, '..', '..', '..', '..');

const MODULES = [
  'rn-bgsched',
  'rn-clipboard',
  'rn-fspaths',
  'rn-notify',
  'rn-qrscanner',
  'rn-securestore',
  'rn-share',
];

const POD_NAMES: Record<string, string> = {
  'rn-bgsched': 'BgSched',
  'rn-clipboard': 'Clipboard',
  'rn-fspaths': 'FsPaths',
  'rn-notify': 'Notify',
  'rn-qrscanner': 'QrScanner',
  'rn-securestore': 'SecureStore',
  'rn-share': 'Share',
};

// Minimal glob -> RegExp for the shapes these podspecs use. Supports an
// optional "<dir>/**/" prefix and a required "{ext,ext}" suffix, which covers
// "*.{swift,mm,h}" (current) and "<dir>/**/*.{swift,mm,h}" (the bug).
function globToRegExp(glob: string): RegExp {
  const exts = glob.match(/\{([^}]+)\}/)?.[1].split(',') ?? ['*'];
  // Strip the "<dir>/**/*." or "*." tail, leaving any literal dir prefix.
  const dir = glob.slice(0, glob.indexOf('{')).replace(/\/?(\*\*\/)?\*\.?$/, '');
  const body = dir
    .split('/')
    .filter((p) => p !== '' && p !== '.')
    .map((p) => p.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
    .join('\\/');
  // '**' collapses to any number of intermediate dirs, including none. A
  // LITERAL dir prefix stays REQUIRED: CocoaPods globs from the podspec's own
  // directory, so "ios/**" can only match if a real "ios/" subdirectory exists
  // inside it, and there is none. That is the whole bug. (Making it optional
  // here made this test pass on the broken glob -- a mutation check caught it.)
  const prefix = body ? `(?:(?:${body})\\/)` : '';
  return new RegExp(
    `^${prefix}(?:[^/]+\\/)*([^/]+)\\.(${exts.join('|')})$`,
  );
}

describe('every iOS TurboModule podspec actually compiles sources', () => {
  for (const name of MODULES) {
    it(`${name} source_files matches at least one real file`, () => {
      const podspecDir = join(repoRoot, 'modules', name, 'ios');
      const spec = readFileSync(
        join(podspecDir, `Daak${POD_NAMES[name]}.podspec`),
        'utf8',
      );
      const glob = spec.match(/s\.source_files\s*=\s*"([^"]+)"/)?.[1];
      expect(glob).toBeDefined();

      // Match against the files that ACTUALLY sit beside the podspec, which is
      // what CocoaPods globs from (PODS_TARGET_SRCROOT == the podspec's own
      // directory, as react-native.config.js points podspecPath here). A glob
      // can only match what is there.
      const re = globToRegExp(glob as string);
      const hits = readdirSync(podspecDir).filter((f) => re.test(f));
      expect(hits).not.toHaveLength(0);
    });
  }
});

// The getEnforcing crash had TWO independent causes, and fixing only the first
// leaves this file unable to catch a regression of the second. Both are
// source-level facts, so both are asserted here.
//
// CAUSE 2, the registration path. The seven modules deliberately do NOT conform
// to their generated @protocol NativeDaak*Spec, and that is CORRECT, not a bug.
// It was measured, not assumed:
//
//   Podfile :new_arch_enabled => true
//     -> RCTAppDelegate.bridgelessEnabled returns newArchEnabled (RCTAppDelegate.mm:164)
//     -> RCTRootViewFactory.mm:151-156, under `if (bridgelessEnabled)`, calls
//        RCTEnableTurboModuleInterop(YES) + InteropBridgeProxy(YES)
//     -> RCTTurboModuleManager.mm:238, under RCTTurboModuleInteropEnabled(), walks
//        RCTGetModuleClasses() and registers every class for which
//        isTurboModuleClass() is false, keyed by RCTBridgeModuleNameForClass
//     -> RCT_EXTERN_MODULE expands to RCT_EXPORT_MODULE_NO_LOAD, whose +load calls
//        RCTRegisterModule([objc_name class]) (RCTBridgeModule.h:88-96), which is
//        what puts the class into RCTGetModuleClasses()
//
// and on the JS side TurboModuleRegistry.requireModule falls through to
// `NativeModules[name]` because useLegacyNativeModuleInterop is true when
// global.RN$TurboInterop === true (TurboModuleRegistry.js:18-38).
//
// The working main module is the proof this shape is sufficient: apps/mobile/
// ios/Daak.swift is also a bare RCTEventEmitter with RCT_EXTERN_MODULE in
// DaakModule.mm and no spec conformance, and it resolves. `Daak` is evaluated
// FIRST (packages/platform/src/engine.ts imports the @daak/core barrel, and the
// barrel re-exports NativeDaak), so the red box naming `DaakBgSched` rather
// than `Daak` is itself evidence that the legacy path worked for Daak and would
// have worked for the rest.
//
// So the invariant that matters is: the class must still reach RCTRegisterModule,
// i.e. its .mm must still carry RCT_EXTERN_MODULE under the exact name JS asks
// for. If someone 'modernises' these modules by deleting RCT_EXTERN_MODULE on the
// assumption that spec conformance replaces it, every one of them silently stops
// registering -- and the ONLY symptom is the same getEnforcing red box, on a
// green build, with the pod linked and its classes present in the dylib. That is
// the exact failure this test exists to catch.
describe('every iOS TurboModule still registers via the legacy interop path', () => {
  for (const name of MODULES) {
    const pod = POD_NAMES[name];

    it(`${name} keeps RCT_EXTERN_MODULE under the name JS asks for`, () => {
      const mm = readFileSync(
        join(repoRoot, 'modules', name, 'ios', `Daak${pod}.mm`),
        'utf8',
      );
      // The macro is what expands to RCTRegisterModule. Its second argument is
      // the ObjC superclass (NSObject or RCTEventEmitter), its FIRST is the class
      // name -- the string TurboModuleRegistry.getEnforcing('<name>') must match,
      // character for character.
      expect(mm).toMatch(
        new RegExp(`RCT_EXTERN_MODULE\\(\\s*Daak${pod}\\s*,`),
      );
      // And it must be the real macro, not this file's own prose mentioning it.
      expect(mm).not.toMatch(/^\s*\/\/.*RCT_EXTERN_MODULE\(/m);
    });

    it(`${name} JS spec asks for exactly the name the .mm registers`, () => {
      const spec = readFileSync(
        join(repoRoot, 'modules', name, 'js', `NativeDaak${pod}.ts`),
        'utf8',
      );
      // A rename on the .mm side or the JS side is silent at compile time and
      // fatal at launch. This pins the JS half of that triangle to the same
      // string the .mm half uses.
      expect(spec).toMatch(new RegExp(`getEnforcing<\\w+>\\('Daak${pod}'\\)`));
    });

    it(`${name} Swift class is @objc-named to match`, () => {
      const swift = readFileSync(
        join(repoRoot, 'modules', name, 'ios', `Daak${pod}.swift`),
        'utf8',
      );
      // RCT_EXTERN_MODULE declares a category on the class named by its first
      // argument, and RCTRegisterModule([Daak<Pod> class]) resolves that name.
      // Without the matching @objc(Daak<Pod>) the macro would attach to a class
      // that does not exist. This is belt-and-braces, but it is the string that
      // makes the two halves one.
      expect(swift).toMatch(new RegExp(`@objc\\(Daak${pod}\\)`));
    });
  }
});

// CAUSE 3, the one the getEnforcing crash could not show. Fixing cause 1 made
// the pods compile, and fixing that made them REGISTER -- which surfaced three
// methods JS calls but the .mm never declared: DaakFsPaths.exists,
// DaakShare.consumeIntentSends and DaakShare.updateShortcutTargets. All three
// were @objc in the .swift and present in the TS Spec, so both languages agreed
// and only the ObjC method table was short. That is invisible to the compiler
// (an unimplemented selector is a runtime "unrecognized selector", not a build
// error) and invisible to every test above, which check the module NAME and
// never the METHOD LIST.
//
// consumeIntentSends is on the startup path -- bootstrap.ts awaits it -- so this
// would have been a launch-time crash, found only by running the app.
describe('every method in the JS Spec is exported by the .mm table', () => {
  // `name(args): Promise<T>;` / `name(args): void;` at the top level of
  // `interface Spec`. addListener/removeListeners are RCTEventEmitter's and are
  // declared by the base class, not by the table.
  const specMethodsOf = (src: string): string[] =>
    [...src.matchAll(/^ {2}([a-zA-Z]\w*)\([^)]*\)\s*:\s*(?:Promise<|void)/gm)]
      .map((m) => m[1])
      .filter((m) => m !== 'addListener' && m !== 'removeListeners');

  // RCT_EXTERN_METHOD's first selector piece IS the method name. Matched
  // against the real macro so this file's own prose cannot satisfy it.
  const mmMethodsOf = (src: string): string[] =>
    [...src.matchAll(/RCT_EXTERN_METHOD\(\s*([a-zA-Z]\w*)\s*:/g)].map(
      (m) => m[1],
    );

  for (const name of MODULES) {
    const pod = POD_NAMES[name];
    const read = (p: string) => readFileSync(join(repoRoot, p), 'utf8');
    const specPath = `modules/${name}/js/NativeDaak${pod}.ts`;
    const mmPath = `modules/${name}/ios/Daak${pod}.mm`;

    it(`${name} .mm declares every Spec method`, () => {
      const specMethods = specMethodsOf(read(specPath));
      expect(specMethods.length).toBeGreaterThan(0);
      const mmMethods = new Set(mmMethodsOf(read(mmPath)));
      expect(specMethods.filter((m) => !mmMethods.has(m))).toEqual([]);
    });

    it(`${name} .mm declares nothing the Spec does not`, () => {
      // The other direction: a .mm entry with no Spec method is unreachable code,
      // and it is how a rename leaves two halves behind.
      const specMethods = new Set(specMethodsOf(read(specPath)));
      expect(mmMethodsOf(read(mmPath)).filter((m) => !specMethods.has(m))).toEqual(
        [],
      );
    });
  }
});
