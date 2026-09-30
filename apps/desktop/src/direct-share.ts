// Desktop-only. Deliberately NOT in modules/rn-share/js/index.ts: that barrel
// is mobile-reachable, and its own header says a desktop-only module must never
// land there (a mobile build that could see it would have to stub it out).
//
// Deep import, not the @daak/rn-share barrel, for the same reason
// src/window-host.ts avoids @daak/rn-tray: the barrel's default export evaluates
// a TurboModuleRegistry.getEnforcing() that throws when the module is absent.
// This file is one of the two places that must tolerate its absence, so it must
// not evaluate the spec.
import { NativeModules } from 'react-native';
import { Linking } from 'react-native';
import type { DeviceInfo } from '@daak/core/src/engine/types';
import { parseDirectShareRoute } from './routes';
import { openDashboard } from './window-host';

interface DirectShareModule {
  setDevices(json: string): Promise<void>;
}

// The ObjC class is RNDirectShare, exported as DaakDirectShare (macOS only).
//
// Read from NativeModules INSIDE the call, not captured at module-eval time:
// this module is imported at the top of apps/desktop/index.js, which runs before
// the bridge is initialised, so a value captured here would be undefined on the
// real app just as it was in the test. The bridge populates NativeModules as
// modules register, so by the time a device list arrives, it is there.
function nativeModule(): DirectShareModule | undefined {
  return NativeModules.DaakDirectShare as DirectShareModule | undefined;
}

// What the native menu actually renders. The daemon-side DeviceInfo also
// carries `addr` and `online`; both are dropped, because the menu shows a name
// and an id and nothing else, and the payload crosses into native code where an
// extra LAN address has no use.
//
// A device with no name is published with an empty name rather than dropped.
// The native side is the one that decides a nameless device is unusable (it
// skips such an entry); hiding it here would make the menu say "nothing is
// paired" for a device that IS paired, which is a quieter lie than a blank row.
export function devicesToMenuJson(devices: DeviceInfo[]): string {
  return JSON.stringify(devices.map((d) => ({ deviceId: d.deviceId, name: d.name ?? '' })));
}

// No-op when the native module is absent (every non-macOS build) and swallows a
// native rejection: an unhandled rejection from a menu publish tells nobody
// anything actionable, and the menu simply keeps what it had.
export function publishDevices(devices: DeviceInfo[]): Promise<void> {
  const native = nativeModule();
  if (!native) return Promise.resolve();
  return Promise.resolve()
    .then(() => native.setDevices(devicesToMenuJson(devices)))
    .then(() => undefined, () => undefined);
}

// ---------------------------------------------------------------------------
// The INBOUND half: a daak://send?deviceId=... link that opened the app, and the
// peer the composer must be pointed at afterwards.
//
// This is a module-level store, not React state, for one concrete reason: the
// dashboard window is created at launch and merely orderOut (AppDelegate.mm), so
// the tree is ALREADY mounted when a link arrives. A setter in a component that
// mounted before the event would need a store above it; this file is imported by
// index.js, which is above both roots. useSyncExternalStore in the shell reads
// it and re-renders the already-mounted dashboard.
//
// Deliberately NOT a `Platform.OS` branch: packages/ui takes this as an optional
// prop, and only the desktop shell supplies it, so the UI package stays free of
// platform conditionals and mobile is untouched.
let directSharePeer: string | null = null;
const peerListeners = new Set<() => void>();

export function getDirectSharePeer(): string | null {
  return directSharePeer;
}

export function setDirectSharePeer(deviceId: string | null): void {
  if (deviceId === directSharePeer) return;
  directSharePeer = deviceId;
  peerListeners.forEach((listener) => listener());
}

export function subscribeDirectSharePeer(listener: () => void): () => void {
  peerListeners.add(listener);
  return () => {
    peerListeners.delete(listener);
  };
}

// Set the target, THEN open the window. The dashboard is already mounted, so the
// two orders are observably different: opening first would order the window in
// pointing at devices[0] and paint one wrong-peer frame before the target lands.
export function applyDirectShareUrl(url: string | null): boolean {
  const route = url === null ? null : parseDirectShareRoute(url);
  if (!route) return false;
  setDirectSharePeer(route.deviceId);
  void openDashboard();
  return true;
}

// Subscribes to BOTH sources, deliberately:
//   getInitialURL() is a cold-launch link, delivered once, with no event after
//   it -- missing it means the app opens to the dashboard with no target.
//   addEventListener('url') is a link delivered to an already-running app.
// React Native's own onDeepLink helper (apps/mobile/src/deeplink.ts:72) exists
// for the same pair of reasons; the only reason this is not a shared helper is
// that the two apps' ROUTES are different, and sharing the plumbing would be
// sharing a contract that is precisely what the cross-package test pins.
//
// The rejection handler is the second .then argument, not a .catch: on macOS
// getInitialURL rejects when nothing registered the scheme, and an unhandled
// rejection here would take down a link that was optional.
export function onDirectShareUrl(): () => void {
  void Linking.getInitialURL().then(
    (url) => {
      applyDirectShareUrl(url);
    },
    () => {},
  );
  const sub = Linking.addEventListener('url', ({ url }) => {
    applyDirectShareUrl(url);
  });
  return () => sub.remove();
}
