// Desktop-only store for the files that the Finder service "Send with Daak"
// hands to the app. The native module DaakSystemShare holds the paths until
// JavaScript takes them.
//
// This file reads NativeModules inside each call. It does not use a spec
// import. A spec import evaluates getEnforcing at load, and that call throws
// when the module is absent. index.js runs before the bridge fills
// NativeModules, so a missing module is a normal case here.
import { NativeEventEmitter, NativeModules, type NativeModule } from 'react-native';
import type { DaakEngine, DeviceInfo } from '@daak/core/src/engine/types';
import { setDirectSharePeer } from './direct-share';
import { openDashboard } from './window-host';

export type ServiceFiles = { files: string[]; token: number };

// NativeModule adds addListener and removeListeners, which NativeEventEmitter needs.
interface SystemShareModule extends NativeModule {
  takePendingFiles(): Promise<unknown>;
}

const EVENT = 'DaakServiceFilesPending';

function nativeModule(): SystemShareModule | undefined {
  return NativeModules.DaakSystemShare as SystemShareModule | undefined;
}

let current: ServiceFiles | null = null;
// The token comes from this counter. It never derives from the old value,
// because consumeServiceFiles sets the value to null.
let lastToken = 0;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

// getServiceFiles returns the same object until the next set or consume call.
// useSyncExternalStore needs a stable identity between notifications.
export function getServiceFiles(): ServiceFiles | null {
  return current;
}

// Clear the direct-share peer first. Two targets at the same time are not valid.
export function setServiceFiles(paths: string[]): void {
  setDirectSharePeer(null);
  lastToken += 1;
  current = { files: paths, token: lastToken };
  notify();
}

export function consumeServiceFiles(): void {
  current = null;
  notify();
}

// A rejection from engine.send propagates. The store stays unchanged then, so
// the user can pick another device. The handle cancels the queued transfer.
// A newer delivery can arrive during the send. The store keeps it.
export async function sendServiceFiles(
  engine: DaakEngine,
  device: DeviceInfo,
  share: { files: string[] },
): Promise<{ cancel: () => Promise<void> }> {
  const started = getServiceFiles();
  const { transferId } = await engine.send({ peerDeviceId: device.deviceId, files: share.files });
  if (getServiceFiles() === started) consumeServiceFiles();
  return { cancel: () => engine.cancel(transferId) };
}

export function subscribeServiceFiles(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Take the pending paths from native code. Set the store first, then open the
// window, so the dashboard never paints a frame without the files. A missing
// module, a native rejection, a non-array result, and an empty list all mean
// "nothing pending". This function always resolves. When openDashboard rejects,
// the store keeps the files, and the user opens the window by hand.
export async function pullServiceFiles(): Promise<void> {
  const native = nativeModule();
  if (!native) return;
  let result: unknown;
  try {
    result = await native.takePendingFiles();
  } catch {
    return;
  }
  if (!Array.isArray(result) || result.length === 0) return;
  setServiceFiles(result as string[]);
  try {
    await openDashboard();
  } catch {
    // The files stay in the store. A rejection here has no action for the user.
  }
}

// Pull once, then listen for later deliveries. Return a function that removes
// the listener. When the native module is absent, do nothing and return a no-op.
export function onServiceFiles(): () => void {
  const native = nativeModule();
  if (!native) return () => {};
  void pullServiceFiles();
  const sub = new NativeEventEmitter(native).addListener(EVENT, () => {
    void pullServiceFiles();
  });
  return () => sub.remove();
}
