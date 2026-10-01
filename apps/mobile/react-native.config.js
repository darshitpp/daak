const path = require('path');
const { readdirSync } = require('fs');

// Autolinking override. The RN CLI resolves an iOS pod with a NON-recursive glob
// for '*.podspec' at the PACKAGE ROOT (cli-config-apple/config/findPodspec), and
// rn-notify/rn-share additionally have a ROOT podspec that declares only :osx,
// so iOS skips it (cli-platform-ios/native_modules.rb, `next unless
// spec.supported_on_platform?`). Measured with `react-native config --platform
// ios` on 2026-10-01, the result was that ZERO of the seven @daak iOS
// TurboModules were linked: Podfile.lock had no Daak* pod at all, and the app
// died at launch on TurboModuleRegistry.getEnforcing('DaakBgSched').
//
// Naming the podspecs here is the CLI's own supported override and is the
// smallest fix. Moving them to the package root would collide with the macOS
// specs of the same name, and Podfile surgery would be per-platform.
//
// Each path points at the :ios spec. rn-notify and rn-share each have TWO
// podspecs of the same name (a root one for macOS, an ios/ one for iOS) and
// CocoaPods is fine with the pair, so the macOS side is untouched. Asserted by
// src/__tests__/iosAutolinking.test.ts, including against the CLI's own output --
// a config the CLI ignores would look correct there and link nothing.
const modules = [
  'rn-bgsched',
  'rn-clipboard',
  'rn-fspaths',
  'rn-notify',
  'rn-qrscanner',
  'rn-securestore',
  'rn-share',
];

const dependencies = {};
for (const dir of modules) {
  const iosDir = path.resolve(__dirname, '..', '..', 'modules', dir, 'ios');
  // The podspec name equals neither the package name nor the folder name, so it
  // is read off disk rather than guessed from `dir`.
  const podspec = readdirSync(iosDir).find((f) => f.endsWith('.podspec'));
  dependencies[`@daak/${dir}`] = {
    platforms: { ios: { podspecPath: path.join(iosDir, podspec) } },
  };
}

module.exports = { project: { ios: {}, android: {} }, dependencies };
