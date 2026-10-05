/*
 * The @daak/platform module factory, as a plain function so the jest hoisting
 * rule cannot bite.
 *
 * WHY THIS EXISTS. The real barrel reaches the `Daak` TurboModule at module-eval
 * time through @daak/core, and pulls cbor-x (ESM) in with it, so jest cannot
 * parse it under the react-native preset. Every test that renders App therefore
 * has to swap the barrel for the handful of facades the app actually calls.
 *
 * WHY A FUNCTION. `jest.mock` factories may only reference variables whose names
 * start with `mock`, so the four test files that needed one grew their own copy
 * -- and they had already drifted: App.tsx now imports readOnboarding, so three
 * of them threw "readOnboarding is not a function" at mount. One factory, and
 * the four call sites spread it with the per-test overrides they actually want.
 *
 * The onboarding keys are here and not optional because App reads them BEFORE it
 * renders anything: a first launch is decided by readOnboarding, so a mock that
 * omitted it would leave every shell test staring at Welcome.
 */
// The `mock` prefix is load-bearing, not decoration. babel-plugin-jest-hoist
// hoists every jest.mock call above the imports and then refuses any factory
// that references an out-of-scope identifier not on its allowlist, whose only
// escape hatch is a name starting with `mock`. Naming this `platformHostMock`
// fails at transform time with "The module factory of jest.mock() is not
// allowed to reference any out-of-scope variables", before a test runs.
export function mockPlatformHost(overrides: Record<string, unknown> = {}) {
  return {
    // App.tsx's own import. Defaults to a COMPLETED onboarding so a test about
    // the shell gets the shell; onboarding.test.tsx drives the first-launch path
    // by overriding readOnboarding per test.
    readOnboarding: jest.fn(async () => ({
      complete: true,
      name: 'Seawood Otter',
      discovery: true,
      alerts: true,
    })),
    writeOnboarding: jest.fn(async () => true),
    INITIAL_ONBOARDING: { complete: false, discovery: false, alerts: false },
    permissionRows: jest.fn((facts: { notificationsGranted?: boolean }) => ({
      rows: [],
      stillNeeded: facts.notificationsGranted === true ? [] : ['Alerts when a file arrives'],
    })),
    withNotificationReask: jest.fn(() => []),
    // The welcome screen's per-platform copy. Real implementation in
    // packages/platform/src/onboarding-copy.ts. The mock returns the shared
    // screen's defaults, which are the Android words, because jest's
    // react-native preset reports Platform.OS as 'ios' -- returning the iOS
    // words here would make every onboarding test assert the wrong surface.
    welcomeCopyFor: jest.fn(() => ({})),
    // The four native facades the app's non-mocked modules call.
    pickFiles: jest.fn(async () => [] as string[]),
    revealInFileManager: jest.fn(async () => true),
    presentShare: jest.fn(async () => true),
    requestBatteryExemption: jest.fn(async () => false),
    pairingBundle: jest.fn(async () => ''),
    generateQr: jest.fn(async () => ''),
    PAIRING_QR_SIZE: 512,
    scanQr: jest.fn(async () => ''),
    ...overrides,
  };
}
