// Desktop file picker. Deep import of the SPEC path, for the same reason
// src/notify.ts:1-12 and src/direct-share.ts:5-9 record: the @daak/rn-share
// barrel default-exports a TurboModuleRegistry.getEnforcing call, and this
// module is loaded by vitest under a react-native stub with no bridge.
//
// It is the DESKTOP module (DaakSystemShare), not the mobile one: adding a
// `DaakShare` for macOS is what modules/rn-share/js/index.ts argues against in
// prose, and RNShare.mm already registers DaakSystemShare on macOS.
export type FilePicker = (multiple: boolean) => Promise<string[]>;

// Lazy, not top-level: NativeDaakSystemShare.ts evaluates getEnforcing at module
// scope, which throws under the vitest stub and, in the real app, before the
// bridge is up. Same shape as onDesktopNotify's require (src/notify.ts:124).
//
// EXPORTED, and named for what it is. It used to be a module-private
// `nativePicker` that desktopPickFiles fell back to with `attached ??
// nativePicker`, and index.js attached desktopPickFiles. Those two lines
// together are an infinite recursion: attach the wrapper, and the wrapper's
// first line hands the call straight back to itself. On the first "Add files"
// click the dashboard hung with no error and no red box -- the panel simply
// never opened. The implementation and the caller are now two separate
// exports and index.js attaches the implementation; test/picker.spec.ts pins
// that on source.
export function nativeDesktopPickFiles(multiple = true): Promise<string[]> {
  const mod = require('@daak/rn-share/js/NativeDaakSystemShare') as typeof import('@daak/rn-share/js/NativeDaakSystemShare');
  return mod.default.pickDocuments(multiple);
}

// INJECTION, as src/notify.ts does, and it is not decoration: the require above
// is a Node `require` under vitest, which cannot load a .ts module, so a spec
// that called the default would die on MODULE_NOT_FOUND rather than on anything
// about the picker. That is why notify.spec.ts only reaches the pure functions
// above the line -- the lazy-require arm there has no test. Injecting makes the
// path the composer actually calls assertable, and index.js still wires the real
// native panel through attachPicker at startup.
let attached: FilePicker | undefined;

export function attachPicker(pick: FilePicker): void {
  attached = pick;
}

// Resolves to an EMPTY LIST on a dismissed panel (RNShare.mm) and never rejects:
// the composer appends whatever comes back, and a rejection here would be an
// unhandled rejection in the shipped app over an ordinary Cancel click.
export async function desktopPickFiles(multiple = true): Promise<string[]> {
  if (!attached) throw new Error('desktopPickFiles: attachPicker must run first');
  return attached(multiple);
}
