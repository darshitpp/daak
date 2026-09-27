import { describe, expect, it } from 'vitest';
import { createEngine } from './engine';
import type { DaakEvent } from '@daak/core';
import type { Spec as NativeDaakSpec } from '@daak/core/src/NativeDaak';

describe('createEngine', () => {
  it('binds the native module and forwards events as the typed union', async () => {
    const calls: unknown[][] = [];
    const fakeNative: NativeDaakSpec = {
      start: async (...a) => { calls.push(['start', ...a]); },
      shutdown: async () => { calls.push(['shutdown']); },
      listDevices: async () => JSON.stringify([]),
      pairingBundle: async () => '{}',
      pairWith: async (addr, bytes) => { calls.push(['pairWith', addr, bytes.length]); return '123456'; },
      acceptPairing: async () => '123456',
      sendText: async (peer, text) => { calls.push(['sendText', peer, text]); return 'aa'.repeat(16); },
      sendFiles: async (peer, paths) => { calls.push(['sendFiles', peer, paths]); return 'bb'.repeat(16); },
      listInbox: async () => '[]',
      listTransfers: async () => '[]',
      cancel: async () => {},
      retry: async () => {},
      setDisplayName: async () => {},
      setPresence: async () => {},
      localPort: async () => 40001,
      addListener: () => {},
      removeListeners: () => {},
    };
    let handler: ((e: DaakEvent) => void) | null = null;
    const subscribe = (cb: (e: DaakEvent) => void) => { handler = cb; return () => { handler = null; }; };

    const engine = createEngine(fakeNative, subscribe);
    const seen: DaakEvent[] = [];
    engine.on((e) => seen.push(e));
    await engine.start();
    (handler as unknown as (e: DaakEvent) => void)({ type: 'transfer.progress', transferId: 't', bytesDone: 1, bytesTotal: 2 });

    expect(calls[0][0]).toBe('start');
    expect(seen).toEqual([{ type: 'transfer.progress', transferId: 't', bytesDone: 1, bytesTotal: 2 }]);
  });
});
