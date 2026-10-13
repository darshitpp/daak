// Typed stand-in for the react-native surface the DESKTOP sources touch under
// vitest. Real behaviour belongs to the native runtime; this only has to be
// shaped right so a mis-wired import fails here instead of in the app.
//
// Four consumers:
//   - apps/mobile/src/deeplink.ts imports { Linking } (imported for real by
//     test/direct-share-contract.spec.ts),
//   - apps/desktop/src/window-host.ts imports { NativeModules },
//   - packages/ui/src/theme.ts imports { StyleSheet } (evaluated at module
//     scope by anything that touches `ui`),
//   - test/gate-render.spec.ts RENDERS the onboarding gate, so every host
//     component packages/ui draws with has to exist here as a renderable
//     string. They are plain strings, not components: react-test-renderer
//     accepts a string as a host type, and a function would have to be a
//     component and would change what the tree looks like.
export const Linking = {
  getInitialURL(): Promise<string | null> { return Promise.resolve(null); },
  addEventListener(_type: 'url', _cb: (e: { url: string }) => void): { remove(): void } { return { remove() {} }; },
};

export const NativeModules: Record<string, unknown> = {};

// The tray spec, and anything else that calls TurboModuleRegistry.getEnforcing
// at MODULE-EVAL time. getEnforcing throws in the real runtime when the module
// is absent, which is exactly what we want it to do in the app -- but a vitest
// import of a file that merely imports such a module would die on collection
// rather than on anything about the code under test. So the registry is present
// and returns a recorder; each spec file asserts on the recorder if it cares,
// and a file that does not care never notices.
export const TurboModuleRegistry = {
  get<T>(name: string): T | null {
    return (recorder.modules[name] ?? null) as T | null;
  },
  getEnforcing<T>(name: string): T {
    const existing = recorder.modules[name];
    if (existing === undefined) {
      const created = createRecordingModule(name);
      recorder.modules[name] = created;
      return created as T;
    }
    return existing as T;
  },
};

/** Every module this stub handed out, so a test can assert on a native call. */
export const recorder = {
  modules: {} as Record<string, Record<string, unknown>>,
  /** Calls made on `name`, in order, as 'method:jsonArgs'. */
  calls(name: string): string[] {
    const mod = recorder.modules[name];
    return mod && Array.isArray(mod.__calls) ? (mod.__calls as string[]) : [];
  },
};

function createRecordingModule(name: string): Record<string, unknown> {
  const calls: string[] = [];
  const mod: Record<string, unknown> = { __calls: calls, __name: name };
  const target = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (typeof prop !== 'string') return undefined;
        return (...args: unknown[]) => {
          calls.push(prop + ':' + JSON.stringify(args));
          return Promise.resolve(undefined);
        };
      },
    },
  );
  return new Proxy(mod, {
    get(t, prop: string) {
      if (prop in t) return (t as Record<string, unknown>)[prop];
      return (target as Record<string, unknown>)[prop];
    },
  });
}

// modules/rn-tray/js/index.ts constructs this at module scope with the tray
// module, and only ever calls addListener on it.
export class NativeEventEmitter {
  constructor(_nativeModule?: unknown) {}
  addListener(_event: string, _cb: (e: unknown) => void): { remove(): void } {
    return { remove() {} };
  }
  removeAllListeners(_event: string): void {}
}

export const StyleSheet = {
  // Identity. The real StyleSheet.create resolves registered IDs to objects in
  // some RN versions and returns them verbatim in others; identity is the only
  // behaviour these tests depend on, because nothing here asserts on style.
  create<T extends Record<string, unknown>>(styles: T): T {
    return styles;
  },
};

export const View = 'View';
export const ActivityIndicator = 'ActivityIndicator';
export const Text = 'Text';
export const Image = 'Image';
export const ScrollView = 'ScrollView';
export const TextInput = 'TextInput';
export const Pressable = 'Pressable';
export const TouchableOpacity = 'TouchableOpacity';
export const Platform = {
  OS: 'macos',
  select: <T,>(spec: { macos?: T; default?: T }): T | undefined => spec.macos ?? spec.default,
};
