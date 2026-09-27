import { NativeEventEmitter } from 'react-native';
import { InProcessEngine, NativeDaak } from '@daak/core';
import type { DaakEngine, EventSubscribe } from '@daak/core';
// InProcessEngine's subscribe contract. Deliberately NOT re-declared: it takes
// the raw native payload -- an object { event: <json> } from Daak.swift:147 /
// DaakModule.kt -- and InProcessEngine itself unwraps and validates it. A
// re-declared type here is how the previous adapter hid that and killed every
// event in production.
export type { EventSubscribe } from '@daak/core';

export function bindDaakEvents(native: { addListener(name: string): void; removeListeners(count: number): void }): EventSubscribe {
  const emitter = new NativeEventEmitter(native);
  return (cb) => {
    const sub = emitter.addListener('DaakEvent', cb);
    return () => sub.remove();
  };
}

export function createEngine(
  native: typeof NativeDaak = NativeDaak,
  subscribe: EventSubscribe = bindDaakEvents(native),
): DaakEngine {
  return new InProcessEngine(native, subscribe);
}
