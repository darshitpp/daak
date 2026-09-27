export * from './engine/types';
export * from './engine/DaemonClient';
export * from './ipc/transport';
export { InProcessEngine } from './engine/InProcess';
export type { EventSubscribe } from './engine/InProcess';
// RN-RUNTIME ONLY. Importing this barrel -- or `NativeDaak` itself -- executes
// `TurboModuleRegistry.getEnforcing('Daak')` at module-eval time, which throws
// outside a running RN app (Node, vitest, Jest, the daemon). Node code should
// import DaemonClient/transport directly from their modules, not from here.
export { default as NativeDaak } from './NativeDaak';
