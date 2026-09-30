export { default } from './NativeDaakShare';
export type { Spec } from './NativeDaakShare';
// shareViaSystem is deliberately NOT re-exported here, and neither is
// SharePayload. This barrel is imported by packages/platform (src/share.ts:1),
// which apps/mobile reaches at launch, and a re-export is an EAGER require:
// system-share.ts imports NativeDaakSystemShare.ts, whose
// TurboModuleRegistry.getEnforcing('DaakSystemShare') throws on iOS/Android
// where only 'DaakShare' is registered. Putting it on the shared barrel would
// make the mobile app throw before its first render.
// ponytail: a desktop-only module must not live on a mobile-reachable barrel.
// Re-export it from here when a caller exists AND mobile registers the module.
export { normalizeShareItems } from './items';
