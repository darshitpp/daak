// Typed stand-in for the bits of react-native @daak/platform touches. Real
// behaviour (event dispatch, Linking, TurboModule registry) belongs to the
// native runtime; tests only need the shapes to exist.
export class NativeEventEmitter {
  constructor(_native?: unknown) {}
  addListener(_name: string, cb: (payload: unknown) => void): { remove(): void } {
    return { remove: () => cb };
  }
}

// `getEnforcing` must not throw at import time: NativeDaak.ts calls it on the
// module body, and every test injects its own native double into createEngine.
export const TurboModuleRegistry = { getEnforcing<T>(_name: string): T { return {} as T; } };

export const Linking = {
  getInitialURL(): Promise<string | null> { return Promise.resolve(null); },
  addEventListener(_type: 'url', _cb: (e: { url: string }) => void): { remove(): void } { return { remove() {} }; },
};
