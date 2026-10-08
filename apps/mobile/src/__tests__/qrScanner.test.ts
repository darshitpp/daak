import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// No Xcode, no CocoaPods, no Android SDK/NDK and no Gradle on this host, so
// every Kotlin and Swift line below is UNVERIFIED by a compiler. These are the
// source-level pins that catch the SILENT failures instead: a TurboModule
// nobody registers, a library that never gets codegen, a scan that dies on a
// missing runtime permission, a QR that renders a 32px dot at the other end.
// The shape is the same contract backgroundExec.test.ts and
// nativeStoreAndPaths.test.ts already hold over the sibling modules.
const read = (p: string) => readFileSync(join(__dirname, p), 'utf8');
const has = (p: string) => existsSync(join(__dirname, p));
const repo = '../../../../';
const qr = repo + 'modules/rn-qrscanner/';
const ktIn = 'android/src/main/java/dev/darshit/daak/qrscanner/';
const ktDir = qr + ktIn;

/** Drops // and block comments: negative pins must read CODE, not rationale. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\/\/.*$/, ''))
    .join('\n');
}

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(__dirname, dir))) {
    if (name === 'node_modules' || name === 'Pods' || name === 'build') continue;
    const p = join(dir, name);
    if (statSync(join(__dirname, p)).isDirectory()) out.push(...sourcesUnder(p));
    else if (/\.(kt|swift|mm|ts|gradle|xml|json)$/.test(name)) out.push(stripComments(read(p)));
  }
  return out;
}

describe('rn-qrscanner has the full module shape', () => {
  // The exact omissions that killed Task 4 (no build.gradle) and Task 8 (no
  // package class) are silent until boot. ScannerActivity is this module's
  // extra file and must exist too, or launchActivityForResult throws at scan
  // time.
  it('has every file, including the scanner activity', () => {
    for (const f of [
      'package.json',
      'js/NativeDaakQrScanner.ts',
      'js/index.ts',
      'ios/DaakQrScanner.swift',
      'ios/ScannerViewController.swift',
      'ios/DaakQrScanner.mm',
      'ios/DaakQrScanner.podspec',
      'android/build.gradle',
      'android/src/main/AndroidManifest.xml',
      ktIn + 'DaakQrScannerModule.kt',
      ktIn + 'DaakQrScannerPackage.kt',
      ktIn + 'ScannerActivity.kt',
    ]) {
      expect(has(qr + f)).toBe(true);
    }
  });

  it('declares the codegen config the autolinker needs', () => {
    const pkg = JSON.parse(read(qr + 'package.json'));
    expect(pkg.codegenConfig.name).toBe('DaakQrScannerSpec');
    expect(pkg.codegenConfig.type).toBe('modules');
    expect(pkg.codegenConfig.jsSrcsDir).toBe('js');
    expect(pkg.codegenConfig.android.javaPackageName).toBe('dev.darshit.daak.qrscanner');
    expect(pkg['react-native']).toBe('js/index.ts');
  });

  it('applies com.facebook.react so library codegen registers the spec', () => {
    const gradle = stripComments(read(qr + 'android/build.gradle'));
    expect(gradle).toMatch(/apply plugin: 'com\.facebook\.react'/);
    expect(gradle).toMatch(/minSdkVersion 24/);
    expect(gradle).toContain("namespace 'dev.darshit.daak.qrscanner'");
  });
});

describe('the TurboModule is typed by its Spec and registered', () => {
  // R44: a getEnforcing<any> loses every type error the Spec exists to catch.
  it('types by Spec, never getEnforcing<any>', () => {
    const spec = stripComments(read(qr + 'js/NativeDaakQrScanner.ts'));
    expect(spec).toMatch("TurboModuleRegistry.getEnforcing<Spec>('DaakQrScanner')");
    expect(spec).not.toMatch(/getEnforcing<any>/);
    expect(spec).toMatch(/export interface Spec extends TurboModule/);
    expect(spec).toMatch(/scan\(\): Promise<string>/);
    expect(spec).toMatch(/generate\(payload: string, size: number\): Promise<string>/);
  });

  // R93: no Package class means the registry never sees "DaakQrScanner" and
  // getEnforcing throws at import time. ReactModuleInfo's args are positional;
  // the trailing true is isTurboModule.
  it('declares a BaseReactPackage that returns the module by name', () => {
    const pkg = stripComments(read(ktDir + 'DaakQrScannerPackage.kt'));
    expect(pkg).toMatch(/class DaakQrScannerPackage : BaseReactPackage\(\)/);
    expect(pkg).toMatch(/DaakQrScannerModule\(reactContext\)/);
    expect(pkg).toMatch(/false,\s*\n\s*false,\s*\n\s*false,\s*\n\s*true,/);
  });

  it('lists the module as a dependency of platform and of the app', () => {
    const platform = JSON.parse(read(repo + 'packages/platform/package.json'));
    expect(platform.dependencies['@daak/rn-qrscanner']).toBe('workspace:*');
    const mobile = JSON.parse(read(repo + 'apps/mobile/package.json'));
    expect(mobile.dependencies['@daak/rn-qrscanner']).toBe('workspace:*');
  });
});

describe('the Android scan path', () => {
  const manifest = stripComments(read(qr + 'android/src/main/AndroidManifest.xml'));

  // R92 read-check: the app manifest has no CAMERA line (the plan claimed Task
  // 6 added one -- it did not), so the LIBRARY manifest is what carries it and
  // merge it into the APK. A missing permission here fails at runtime with a
  // SecurityException, not a compile error.
  it('declares CAMERA and the camera feature in the library manifest', () => {
    expect(manifest).toMatch(
      /<uses-permission android:name="android\.permission\.CAMERA"/,
    );
    expect(manifest).toMatch(/android\.hardware\.camera/);
  });

  it('registers ScannerActivity as private', () => {
    const start = manifest.indexOf('android:name=".ScannerActivity"');
    expect(start).toBeGreaterThan(-1);
    expect(manifest.slice(start, manifest.indexOf('/>', start))).toMatch(
      /android:exported="false"/,
    );
  });

  // R92: a manifest declaration is not a runtime grant. Without a request,
  // the camera opens a black PreviewView and the scan never resolves on a real
  // device -- but only on a device, which is why it is pinned here.
  it('requests CAMERA at runtime and starts the camera only after the grant', () => {
    const activity = stripComments(read(ktDir + 'ScannerActivity.kt'));
    expect(activity).toMatch(/ActivityResultContracts\.RequestPermission\(\)/);
    expect(activity).toMatch(/Manifest\.permission\.CAMERA/);
    expect(activity).toMatch(/if \(granted\) startCamera\(\)/);
  });

  it('shares EXTRA_RESULT and EXTRA_ERROR between the activity and the module', () => {
    const activity = stripComments(read(ktDir + 'ScannerActivity.kt'));
    const module = stripComments(read(ktDir + 'DaakQrScannerModule.kt'));
    expect(activity).toMatch(/EXTRA_RESULT/);
    expect(activity).toMatch(/EXTRA_ERROR/);
    expect(module).toMatch(/EXTRA_RESULT/);
    expect(module).toMatch(/EXTRA_ERROR/);
  });

  it('pins the zxing and cameraX dependencies the activity compiles against', () => {
    const gradle = stripComments(read(qr + 'android/build.gradle'));
    expect(gradle).toContain('com.google.zxing:core');
    for (const dep of ['camera-core', 'camera-camera2', 'camera-lifecycle', 'camera-view']) {
      expect(gradle).toContain('androidx.camera:' + dep);
    }
    // ComponentActivity/registerForActivityResult (androidx.activity) and
    // ContextCompat (androidx.core) are used directly and must be declared, not
    // transitive luck -- the review flagged this; rn-bgsched pins core-ktx too.
    expect(gradle).toContain('androidx.core:core-ktx:1.13.1');
    expect(gradle).toContain('androidx.activity:activity-ktx:1.9.3');
  });
});

describe('the iOS scan and generate path', () => {
  it('serves scan and generate from the pod, not the app target', () => {
    // R94: the app-target is only for code that must exist before the RN bridge
    // does. The scanner is only reachable from JS, so it lives in the pod. If it
    // ever moves into the app target, the four pbxproj entries and the
    // nativeStoreAndPaths every-<Daak>/*.swift contract bite -- deliberately.
    const pbxproj = read(repo + 'apps/mobile/ios/Daak.xcodeproj/project.pbxproj');
    expect(pbxproj).not.toMatch(/DaakQrScanner/);
    const pod = read(qr + 'ios/DaakQrScanner.podspec');
    expect(pod).toMatch(/s\.name = "DaakQrScanner"/);
    expect(pod).toMatch(/s\.platforms = \{ :ios => "16\.0" \}/);
    // The glob is relative to the podspec's own directory (modules/rn-qrscanner/
    // ios), so a leading "ios/" pointed at ios/ios/** and the pod compiled ZERO
    // sources -- a green pod install with an empty module. No leading "ios/".
    expect(pod).toMatch(/s\.source_files = "\*\*\/\*\.\{swift,mm,h\}"/);
    expect(pod).not.toMatch(/s\.source_files = "ios\//);
    expect(pod).toMatch(/s\.dependency "React-Core"/);
  });

  it('declares the module and its methods in the ObjC interop', () => {
    const mm = stripComments(read(qr + 'ios/DaakQrScanner.mm'));
    expect(mm).toMatch(/RCT_EXTERN_MODULE\(DaakQrScanner, NSObject\)/);
    expect(mm).toMatch(/RCT_EXTERN_METHOD\(scan:\(RCTPromiseResolveBlock\)resolve/);
    expect(mm).toMatch(/RCT_EXTERN_METHOD\(generate:\(NSString \*\)payload\s+size:\(nonnull NSNumber \*\)size/);
    const swift = stripComments(read(qr + 'ios/DaakQrScanner.swift'));
    expect(swift).toMatch(/@objc\(DaakQrScanner\)/);
    expect(swift).toMatch(/requiresMainQueueSetup/);
  });

  it('pins the camera permission string in Info.plist', () => {
    const plist = read(repo + 'apps/mobile/ios/Daak/Info.plist');
    expect(plist).toContain('<key>NSCameraUsageDescription</key>');
  });

  // A capture session with NO preview layer runs the camera and draws nothing:
  // the green LED lights and the screen stays black, which the user cannot tell
  // apart from a dead camera. The preview layer is the whole visible half of
  // the scan screen.
  it('draws the camera preview, not just the capture session', () => {
    const vc = stripComments(read(qr + 'ios/ScannerViewController.swift'));
    expect(vc).toContain('AVCaptureVideoPreviewLayer(session: session)');
    expect(vc).toMatch(/override func viewDidLayoutSubviews\(\)/);
    expect(vc).toContain('previewLayer?.frame = view.bounds');
  });
});

describe('the module gained no send path', () => {
  // R96: pairing is not a send, and this module must not grow one. The outbox
  // owns every Daak-to-Daak transfer; engine.send appears exactly once, in
  // bootstrap.ts.
  const transport =
    /engine\.send|sendText|sendFiles|uniffi|DaakEngine|\bTCP\b|chacha|Cipher|\.connect\(/;

  it('names no transport or crypto anywhere in modules/rn-qrscanner', () => {
    for (const source of sourcesUnder(repo + 'modules/rn-qrscanner')) {
      expect(source).not.toMatch(transport);
    }
  });
});

describe('the QR size, EC level and capacity contract is explicit and shared', () => {
  // Review IMPORTANT: 512 was a bare default and iOS (M) disagreed with zxing's
  // default (L), giving each platform a different capacity ceiling that no test
  // asserted. Both sides now pin level M, and the pair flow renders at the
  // named PAIRING_QR_SIZE against the v40-M ceiling of PAIRING_BUNDLE_BYTE_CEILING.
  it('pins error-correction level M on both native sides', () => {
    const kotlin = stripComments(read(ktDir + 'DaakQrScannerModule.kt'));
    expect(kotlin).toMatch(/EncodeHintType\.ERROR_CORRECTION/);
    expect(kotlin).toMatch(/ErrorCorrectionLevel\.M/);
    const swift = stripComments(read(qr + 'ios/DaakQrScanner.swift'));
    expect(swift).toMatch(/inputCorrectionLevel/);
    expect(swift).toMatch(/"M"/);
  });

  it('pins the shared constants the pair flow renders with', () => {
    const facade = stripComments(read(repo + 'packages/platform/src/qr.ts'));
    expect(facade).toMatch(/PAIRING_QR_SIZE = 512/);
    expect(facade).toMatch(/PAIRING_BUNDLE_BYTE_CEILING = 2331/);
  });
});
