import { NativeEventEmitter } from 'react-native';
import { InProcessEngine, NativeDaak } from '@daak/core';
import type { DaakEngine, DaakEvent } from '@daak/core';

/** Typed event bridge: callbacks see a decoded DaakEvent, never a raw string. */
export type EventSubscribe = (cb: (e: DaakEvent) => void) => () => void;

export function bindDaakEvents(
  native: { addListener(name: string): void; removeListeners(count: number): void },
): EventSubscribe {
  const emitter = new NativeEventEmitter(native as never);
  return (cb) => {
    const sub = emitter.addListener('DaakEvent', cb);
    return () => sub.remove();
  };
}

// InProcessEngine's own subscribe is the raw-string one (it JSON.parses the
// native payload and validates `type`). createEngine is the single adapter
// between that contract and the DaakEvent-typed one above, so nothing else in
// the app has to know the wire is JSON.
export function createEngine(
  native: typeof NativeDaak = NativeDaak,
  subscribe: EventSubscribe = bindDaakEvents(native),
): DaakEngine {
  return new InProcessEngine(native, (cb) => subscribe((e) => cb(JSON.stringify(e))));
}
