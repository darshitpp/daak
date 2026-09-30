// Desktop-only. Deep import, NOT the @daak/rn-notify barrel, for the reason
// src/direct-share.ts:1-9 and src/window-host.ts:1-3 both record: that barrel
// default-exports a TurboModuleRegistry.getEnforcing call, and
// js/system-notify.ts pulls in NativeDaakSystemNotify, whose getEnforcing of
// DaakSystemNotify THROWS on iOS/Android where only DaakNotify is registered.
// This module is imported at the top of apps/desktop/index.js, above both
// roots, so it must not evaluate either spec.
//
// Every import here is TYPE-only, for the same reason src/tray-action.ts:1 is:
// the real system-notify module is pulled in LAZILY inside onDesktopNotify,
// because this file is loaded by vitest under the react-native stub and must
// not touch a TurboModule at all.
import type { DaakEvent } from '@daak/core/src/engine/types';
import type { NotifyAction } from '@daak/rn-notify/js/actions';

// The decision, separated from the effects, for the reason src/tray-action.ts
// gives: openDashboard() takes no argument, so a payload id carried through the
// plan would be read by nobody, and the three ids are not the same effect.
//
// 'open' is the only INSTALLED action, so it is the only plan. 'share' and
// 'show' are withheld at the source under R37 (see
// modules/rn-notify/js/actions.ts inboxActions and the matching table in
// macos/RNNotify.mm): neither has a desktop implementation, and show was
// briefly aliased onto open here, which is a lie by its "Show in folder" label.
// A withheld id is a malformed event and is dropped, never aliased.
export type NotifyActionPlan = 'open-dashboard' | null;

export function planNotifyAction(action: NotifyAction['id']): NotifyActionPlan {
  if (action === 'open') return 'open-dashboard';
  return null;
}

export interface NotifyHost {
  openDashboard(): void;
}

export function applyNotifyAction(action: NotifyAction['id'], host: NotifyHost): void {
  const plan = planNotifyAction(action);
  // A null plan is DROPPED SILENTLY. There is no host effect to call, and
  // waking the window for a payload the user did not ask to open is worse than
  // ignoring the event.
  if (plan === null) return;
  host.openDashboard();
}

// The narrow slice of DaakEngine this file reads, declared here rather than
// taking the full DaakEngine so the test can pass a two-method fake and this
// file cannot grow a dependency on engine methods it has no business calling.
export interface NotifyEngine {
  on(cb: (event: DaakEvent) => void): () => void;
}

export interface InboxBanner {
  payloadId: string;
  itemCount: number;
  summary: string;
}

export interface NotifyDeps {
  post(entry: InboxBanner): Promise<void>;
}

// Posts a banner per inbox.received and NOTHING else. The inbox stays the
// source of truth, exactly as packages/platform/src/notify.ts R36 records for
// mobile: this is a receipt, not a transport, and it never sends anything.
//
// A rejected post is swallowed. This handler is ONE subscription on the ONE
// engine event stream that also carries pairing and transfer events, and an
// unhandled rejection here would take the dashboard down over a denied
// notification permission. Same reasoning as apps/mobile/src/bootstrap.ts:115.
export function notifyInboxEntry(engine: NotifyEngine, deps: NotifyDeps): () => void {
  return engine.on((event) => {
    if (event.type !== 'inbox.received') return;
    void Promise.resolve()
      .then(() => deps.post(event.payload))
      .then(undefined, () => undefined);
  });
}

// ---- the real wiring, below the line the tests import ----

// Set by index.js, which owns the single engine instance for the process and
// hands the same one to both shells. Not captured at import time because this
// module is evaluated before createDesktopEngine resolves.
let engineRef: NotifyEngine | undefined;
// undefined, NOT a no-op resolve. Both attachments are required for
// onDesktopNotify to do anything real, and a missing one is a WIRING BUG in
// index.js, not a runtime condition to absorb. A silent default here once
// disagreed with attachNotifyEngine's throw; now both fail loudly and by the
// same rule. A tap that arrived before attachNotifyHost would otherwise open
// nothing and look identical to a withheld action.
let openDashboardImpl: (() => Promise<void>) | undefined;

export function attachNotifyEngine(engine: NotifyEngine): void {
  engineRef = engine;
}

// Injected rather than importing ./window-host at the top, because window-host
// imports react-native NativeModules and this file is loaded by vitest under a
// stub with no bridge. window-host.ts itself reads NativeModules inside each
// call for the same reason.
export function attachNotifyHost(open: () => Promise<void>): void {
  openDashboardImpl = open;
}

const host: NotifyHost = {
  openDashboard: () => {
    if (openDashboardImpl === undefined) {
      throw new Error('onDesktopNotify: attachNotifyHost must run first');
    }
    void openDashboardImpl();
  },
};

// The one call site, invoked from index.js next to onDirectShareUrl().
//
// The system-notify import is a LAZY require, and that is load-bearing twice
// over: system-notify.ts imports react-native NativeEventEmitter and
// NativeDaakSystemNotify, and NativeDaakSystemNotify evaluates getEnforcing at
// module scope. A top-level import throws under the vitest stub (no
// TurboModuleRegistry) and, in the real app, before the bridge is up. Same lazy
// shape as the emitter in modules/rn-notify/js/system-notify.ts itself.
export function onDesktopNotify(): () => void {
  const mod = require('@daak/rn-notify/js/system-notify') as typeof import('@daak/rn-notify/js/system-notify');
  const engine = engineRef;
  if (engine === undefined) {
    throw new Error('onDesktopNotify: attachNotifyEngine must run first');
  }
  const stopEvents = notifyInboxEntry(engine, { post: (entry) => mod.notifyInbox(entry) });
  const stopActions = mod.onNotifyAction(({ actionId }) => applyNotifyAction(actionId, host));
  return () => {
    stopEvents();
    stopActions();
  };
}
