export * from './engine/types';
export { InProcessEngine } from './engine/InProcess';
export type { EventSubscribe } from './engine/InProcess';
// The barrel is the MOBILE graph. It must not reach `./ipc/transport` or
// `./engine/DaemonClient`: both import node: builtins (node:net, node:os) for
// the daakd TCP socket, and this file is the entry Metro resolves for iOS and
// Android. A node: import anywhere under here is a hard 500 from Metro and a
// red box on launch, on every platform, before any app code runs -- which is
// exactly what it did on 2026-10-01. Desktop deep-imports them instead
// (`apps/desktop/src/engine.ts`), so nothing there needs this barrel.
//
// test/barrelIsRnpure.test.ts walks the graph and fails if that regresses.
//
// RN-RUNTIME ONLY. Importing this barrel -- or `NativeDaak` itself -- executes
// `TurboModuleRegistry.getEnforcing('Daak')` at module-eval time, which throws
// outside a running RN app (Node, vitest, Jest, the daemon). Node code should
// import NativeDaak directly from its module, not from here.
export { default as NativeDaak } from './NativeDaak';
