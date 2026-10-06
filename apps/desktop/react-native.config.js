// The desktop app is macOS + Windows only. Declaring only those two stops the
// community CLI from looking for an ios/ or android/ project that does not
// exist here (apps/mobile declares ios+android; apps/desktop is the mirror).
const { join } = require('node:path');

module.exports = {
  project: { macos: {}, windows: {} },
  // rn-securestore is what desktop onboarding reads and writes the durable
  // first-run state through (apps/desktop/index.js imports readOnboarding and
  // writeOnboarding, which are pure JS over NativeDaakSecureStore). Without it
  // here the keystore module is never linked, and the gate that decides
  // whether the engine may start would have nothing to read -- every launch
  // would look like a first launch, or fail at module-eval time.
  //
  // This is an explicit list rather than autolinking-on: the CLI resolves these
  // from the app's package.json, and this module is a dependency of
  // @daak/platform rather than of this app -- so it is named by PATH, relative
  // to the workspace root. require.resolve() is not an option: pnpm links only
  // direct dependencies, so it throws MODULE_NOT_FOUND from this app and takes
  // the whole `react-native config` run down with it.
  dependencies: {
    // ABSOLUTE, and joined from __dirname rather than written as a literal: the
    // CLI resolves a relative `root` against process.cwd(), which is wherever
    // pod install happened to be run from. A literal '../../modules/...' only
    // works from apps/desktop and fails with "Failed to locate package.json"
    // from anywhere else.
    '@daak/rn-securestore': { root: join(__dirname, '..', '..', 'modules', 'rn-securestore') },
    // The pairing QR. generateQr() calls TurboModuleRegistry.getEnforcing at
    // MODULE EVAL, so without this pod the desktop cannot render a host QR at
    // all -- and it can never pair, so it can never send. Same shape and same
    // reason as rn-securestore above: a dependency of @daak/platform rather
    // than of this app, named by PATH because pnpm links only direct deps.
    '@daak/rn-qrscanner': { root: join(__dirname, '..', '..', 'modules', 'rn-qrscanner') },
    // R42p: the download folder and the move. The module also owns `reveal`,
    // which macOS does for real (activateFileViewerSelecting) -- the desktop
    // had no fspaths pod at all, which is why a received file could not be
    // opened from the Inbox.
    '@daak/rn-fspaths': { root: join(__dirname, '..', '..', 'modules', 'rn-fspaths') },
  },
};
