import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The desktop first-run gate reads and writes the durable state through the OS
 * keystore (apps/desktop/index.js imports readOnboarding/writeOnboarding, which
 * are pure JS over NativeDaakSecureStore). If that module is not LINKED, the
 * gate has nothing to read -- and it fails at module-eval time rather than at
 * any point a JS test could otherwise notice.
 *
 * Two independent ways to get this wrong, both silent, both pinned here:
 *
 *  1. NO PODSPEC. The CLI's findPodspec globs '*.podspec' at the PACKAGE ROOT
 *     with NO recursion, so ios/DaakSecureStore.podspec is invisible to it and
 *     the desktop app gets no pod at all. The root copy is the fix.
 *
 *  2. NOT LISTED IN react-native.config.js. The CLI discovers dependencies from
 *     the app's package.json, and rn-securestore is a dependency of
 *     @daak/platform, not of this app -- so autolinking never sees it and the
 *     root podspec alone changes nothing.
 */
const DESKTOP = join(__dirname, '..');
const MODULE = join(DESKTOP, '..', '..', 'modules', 'rn-securestore');

describe('the desktop app links the keystore it gates onboarding on', () => {
  it('has a podspec at the package root, where the CLI can find it', () => {
    const spec = readFileSync(join(MODULE, 'DaakSecureStore.podspec'), 'utf8');
    expect(spec).toMatch(/s\.name\s*=\s*"DaakSecureStore"/);
    // BOTH platforms in one spec. A spec that declared only :osx would become
    // the file the iOS app never links.
    expect(spec).toMatch(/:ios\s*=>/);
    expect(spec).toMatch(/:osx\s*=>/);
    // 'ios/' with NO leading slash: a leading path resolved against ios/ and
    // compiled zero sources.
    expect(spec).toMatch(/s\.source_files\s*=\s*"ios\/\*\*/);
  });

  it('is named explicitly in react-native.config.js', () => {
    const config = readFileSync(join(DESKTOP, 'react-native.config.js'), 'utf8');
    expect(config).toMatch(/'@daak\/rn-securestore'/);
    // Resolved from __dirname, NOT cwd: the CLI resolves a relative `root`
    // against the working directory, so a literal '../../modules/...' works
    // only when pod install is run from apps/desktop.
    expect(config).toMatch(/join\(__dirname/);
    // NOT require.resolve: pnpm links only direct dependencies, so resolving
    // this module from the desktop app throws MODULE_NOT_FOUND and takes the
    // whole `react-native config` run down with it.
    expect(config).not.toMatch(/require\.resolve\('@daak\/rn-securestore/);
  });

  // kSecUseDataProtectionKeychain is an iOS-13-and-later DEVICE concept with
  // no macOS equivalent, so a shared Swift source has to ask for it only where
  // it exists. Asking unconditionally is a compile error on the Mac; never
  // asking is a keychain that behaves differently from the iOS one.
  it('asks for the data-protection keychain only on iOS', () => {
    const swift = readFileSync(join(MODULE, 'ios', 'DaakSecureStore.swift'), 'utf8');
    expect(swift).toMatch(/kSecUseDataProtectionKeychain/);
    // The guard has to mention the platform, not merely exist.
    expect(swift).toMatch(/#if\s+os\(iOS\)[\s\S]{0,400}kSecUseDataProtectionKeychain/);
  });

  it('declares a react-native-macos entry point so the fork resolves it', () => {
    const pkg = JSON.parse(readFileSync(join(MODULE, 'package.json'), 'utf8')) as Record<string, string>;
    expect(pkg['react-native-macos']).toBe(pkg['react-native']);
  });
});
