import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { startEngine, startEngineOnce } from '../bootstrap';
import { BackgroundSyncNotice } from '../BackgroundSyncNotice';

// GAP 3 in one file: the foreground service must start and stop from the ONE
// engine.on subscription bootstrap.ts already owns, the wake handler must not
// add a second, and the battery-exemption prompt must be behind a tap. The
// plan's wireBackground does all three wrong.
//
// @daak/platform is fully mocked, so the cbor-x ESM barrel never loads.
jest.mock('@daak/platform', () => ({
  createEngine: () => {
    const g = globalThis as unknown as { __bgEngine?: unknown };
    g.__bgEngine ??= jest.requireActual('@daak/ui').fakeEngine();
    return g.__bgEngine;
  },
  consumePendingShare: jest.fn(async () => []),
  consumeIntentSends: jest.fn(async () => []),
  syncShortcutTargets: jest.fn(async () => {}),
  initNotifications: jest.fn(async () => true),
  notifyReceived: jest.fn(async () => {}),
  routeInboxEntry: jest.fn(async () => {}),
  realReceiveDeps: { clipboard: { setString: jest.fn(async () => true) } },
  initBackgroundSync: jest.fn(async () => {}),
  startTransferForeground: jest.fn(async () => {}),
  stopTransferForeground: jest.fn(async () => {}),
  enqueueDrain: jest.fn(async () => {}),
  requestBatteryExemption: jest.fn(async () => {}),
}));

import {
  initBackgroundSync,
  requestBatteryExemption,
  startTransferForeground,
  stopTransferForeground,
} from '@daak/platform';
import type { DaakEngine, DaakEvent } from '@daak/core';

const engine = (globalThis as unknown as { __bgEngine: DaakEngine }).__bgEngine;

const handlers = (): Set<(e: DaakEvent) => void> =>
  (engine as unknown as { __handlers: Set<(e: DaakEvent) => void> }).__handlers;

const emit = (e: DaakEvent) => {
  for (const h of handlers()) h(e);
};

beforeEach(() => jest.clearAllMocks());

describe('startEngine: the foreground service and the one subscription', () => {
  it('books the first background slot', async () => {
    await startEngine();
    expect(initBackgroundSync).toHaveBeenCalled();
  });

  // R42: the foreground service start/stop reacts to transfer events, so it
  // has to live inside the ONE handler. A second engine.on double-starts the
  // service and double-stops it per transfer, and breaks the invariant
  // startEngineSubscription pins.
  it('starts and stops the foreground service from the ONE subscription', async () => {
    await startEngine();
    expect(handlers().size).toBe(1);

    emit({ type: 'transfer.progress', transferId: 't1', bytesDone: 1, bytesTotal: 2 });
    await waitFor(() => expect(startTransferForeground).toHaveBeenCalled());
    expect(handlers().size).toBe(1);

    emit({ type: 'transfer.done', transferId: 't1' });
    await waitFor(() => expect(stopTransferForeground).toHaveBeenCalled());
    expect(handlers().size).toBe(1);
  });

  // transfer.progress fires once per CHUNK. An OS service start per chunk
  // would be hundreds of them on one large file, so the start is latched until
  // a terminal event.
  it('starts the service once per active transfer, not once per chunk', async () => {
    await startEngine();
    emit({ type: 'transfer.progress', transferId: 't1', bytesDone: 1, bytesTotal: 9 });
    emit({ type: 'transfer.progress', transferId: 't1', bytesDone: 2, bytesTotal: 9 });
    emit({ type: 'transfer.progress', transferId: 't1', bytesDone: 3, bytesTotal: 9 });
    await waitFor(() => expect(startTransferForeground).toHaveBeenCalledTimes(1));
  });

  // transfer.failed is the other terminal arm. Missing it leaves a permanent
  // notification in the tray claiming work that already failed.
  it('stops on a failure too', async () => {
    await startEngine();
    emit({ type: 'transfer.progress', transferId: 't1', bytesDone: 1, bytesTotal: 2 });
    await waitFor(() => expect(startTransferForeground).toHaveBeenCalled());
    emit({ type: 'transfer.failed', transferId: 't1', error: 'peer went away' });
    await waitFor(() => expect(stopTransferForeground).toHaveBeenCalled());
  });

  // R22: the lifecycle owner calls startEngine, but must NOT drain the
  // text/file share inbox. consumePendingShare is all-or-nothing natively and
  // deletes the batch metadata that names a shared item, so a mount-time drain
  // orphans bytes. drainInbound stays unwired.
  it('does not drain the text/file share inbox', async () => {
    await startEngine();
    expect(jest.requireMock('@daak/platform').consumePendingShare).not.toHaveBeenCalled();
  });
});

describe('startEngineOnce', () => {
  // Two engines in one process means two identities and two discovery stacks
  // on the LAN. The wrapper is what makes a StrictMode double-invoke, a Fast
  // Refresh or a remount harmless.
  it('returns the same promise, so the engine starts once however often called', async () => {
    const first = startEngineOnce();
    expect(startEngineOnce()).toBe(first);
    await first;
    // One engine.start(): the ONE subscription, not N of them.
    expect(handlers().size).toBe(1);
  });
});

describe('the background-sync affordance', () => {
  it('never opens system battery settings until the button is tapped', async () => {
    render(<BackgroundSyncNotice />);
    // The control is visible...
    expect(screen.getByLabelText('allow-background-sync')).toBeTruthy();
    // ...and nothing has been asked for yet. requestBatteryExemption navigates
    // away from the app, so firing it on mount would eject the user from Daak
    // on first open, unasked.
    expect(requestBatteryExemption).not.toHaveBeenCalled();
  });

  it('requests the exemption on an explicit tap, once', async () => {
    render(<BackgroundSyncNotice />);
    fireEvent.press(screen.getByLabelText('allow-background-sync'));
    await waitFor(() => expect(requestBatteryExemption).toHaveBeenCalledTimes(1));
  });
});
