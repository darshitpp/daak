// Typed stand-in for the bits of react-native @daak/platform touches. Real
// behaviour (event delivery, Linking, TurboModule registry) belongs to the
// native runtime; the stub only has to dispatch like the real emitter so a
// mis-wired event channel fails here instead of on a device.

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Set<Listener>>();

/** Test-only: push a payload down every listener on a channel. */
export function __emit(name: string, payload: unknown): void {
  for (const l of [...(listeners.get(name) ?? [])]) l(payload);
}

/** Test-only: drop every listener, so cases cannot leak into each other. */
export function __reset(): void {
  listeners.clear();
}

export class NativeEventEmitter {
  constructor(_native?: unknown) {}
  addListener(name: string, cb: Listener): { remove(): void } {
    let set = listeners.get(name);
    if (!set) listeners.set(name, (set = new Set()));
    set.add(cb);
    return { remove: () => { set.delete(cb); } };
  }
}

// `getEnforcing` must not throw at import time: NativeDaak.ts calls it on the
// module body, and every test injects its own native double into createEngine.
export const TurboModuleRegistry = {
  getEnforcing<T>(_name: string): T { return {} as T; },
  // The real `get` returns null for a module that the host did not register.
  get<T>(_name: string): T | null { return null; },
};

export const Linking = {
  getInitialURL(): Promise<string | null> { return Promise.resolve(null); },
  addEventListener(_type: 'url', _cb: (e: { url: string }) => void): { remove(): void } { return { remove() {} }; },
};
