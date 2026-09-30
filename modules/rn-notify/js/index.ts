export { default } from './NativeDaakNotify';
export type { Spec } from './NativeDaakNotify';
// system-notify.ts (notifyInbox / onNotifyAction) and actions.ts
// (DesktopNotification / NotifyAction) are deliberately NOT re-exported here.
// This barrel is the MOBILE DaakNotify module and is imported by
// packages/platform/src/notify.ts:1, which apps/mobile reaches at launch; a
// re-export is an EAGER require, and system-notify.ts pulls in
// NativeDaakSystemNotify.ts, whose TurboModuleRegistry.getEnforcing(
// 'DaakSystemNotify') throws on iOS/Android where only 'DaakNotify' is
// registered. Putting it here would make the mobile app throw before its first
// render.
//
// actions.ts alone would be safe here (it imports nothing at all),
// and it is still withheld: a future caller who imports DesktopNotification from
// the barrel and notifyInbox from the deep path has two import styles for one
// module, and the FIRST one of them that grabs the barrel for a value is the one
// that crashes mobile. One rule beats a partially safe subset.
// ponytail: a desktop-only module must not live on a mobile-reachable barrel.
// Re-export when a mobile-safe caller exists AND mobile registers the module.
