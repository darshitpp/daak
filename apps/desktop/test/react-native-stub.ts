// Typed stand-in for the react-native surface the DESKTOP sources touch under
// vitest. Real behaviour belongs to the native runtime; this only has to be
// shaped right so a mis-wired import fails here instead of in the app.
//
// Two consumers:
//   - apps/mobile/src/deeplink.ts imports { Linking } (imported for real by
//     test/direct-share-contract.spec.ts),
//   - apps/desktop/src/window-host.ts imports { NativeModules }.
export const Linking = {
  getInitialURL(): Promise<string | null> { return Promise.resolve(null); },
  addEventListener(_type: 'url', _cb: (e: { url: string }) => void): { remove(): void } { return { remove() {} }; },
};

export const NativeModules: Record<string, unknown> = {};

export const View = 'View';
export const Platform = {
  OS: 'macos',
  select: <T,>(spec: { macos?: T; default?: T }): T | undefined => spec.macos ?? spec.default,
};
