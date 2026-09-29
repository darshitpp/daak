import type { DaakEngine } from '@daak/core';
import { initialUiState, reduceUiState } from './state/store';
import type { AppMode, UiAction, UiState } from './state/store';

export interface UiRuntime {
  getState(): UiState;
  subscribe(listener: (s: UiState) => void): () => void;
  /** Pull the device list from the engine. Call it AFTER engine.start(). */
  prime(): void;
}

// Folds the engine event stream into UiState. Shared by the RN apps (React) and
// the Linux GTK shell (JavaScriptCore), so this module imports no React and no
// react-native.
export function createUiRuntime(engine: DaakEngine): UiRuntime {
  let state: UiState = initialUiState;
  const listeners = new Set<(s: UiState) => void>();
  const notify = () => listeners.forEach((listener) => listener(state));
  // Same object out means nothing changed, so nothing to tell anyone about.
  // Without this every `transfer.item` -- one per file, per batch -- re-rendered
  // the whole tree with a byte-identical snapshot.
  const apply = (action: UiAction) => {
    const next = reduceUiState(state, action);
    if (next === state) return;
    state = next;
    notify();
  };
  engine.on((event) => apply(event));
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    // `device.discovered` is gated on first-ever discovery, so every peer
    // already on the LAN when daakd started has none to send. This is the only
    // way that list fills, so the host calls it once after start() settles.
    //
    // It must NOT run from the constructor: the wire carries one request at a
    // time, so a devices() in flight makes engine.start() throw, and every mode
    // dies before it renders. Even called early it can only reject (the daemon
    // answers "engine not started; send Start first"), so the rejection is
    // swallowed here rather than surfaced -- the list refills on the next call.
    prime: () => {
      void engine.devices().then((devices) => apply({ type: 'devices.loaded', devices })).catch(() => {});
    },
  };
}

export { initialUiState, reduceUiState };
export type { AppMode, UiState };
