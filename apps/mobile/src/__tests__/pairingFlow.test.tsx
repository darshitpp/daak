import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { DaakEngine, DaakEvent } from '@daak/core';
import { AppShell, EngineProvider } from '@daak/ui';
import {
  createEngine,
  generateQr,
  PAIRING_QR_SIZE,
  pairingBundle,
  scanQr,
} from '@daak/platform';
import { startEngine } from '../bootstrap';
import { PairingFlow } from '../PairingFlow';

jest.mock('@daak/platform', () => {
  const { fakeEngine } = jest.requireActual('@daak/ui');
  // bootstrap builds ONE engine at import time via createEngine(); the flow
  // test needs that same instance (the context engine AND the one the single
  // engine.on handler subscribes to must agree).
  const g = globalThis as unknown as { __pairingFlowEngine: DaakEngine | null };
  return {
    createEngine: () => {
      g.__pairingFlowEngine ??= fakeEngine();
      return g.__pairingFlowEngine;
    },
    consumePendingShare: jest.fn(),
    consumeIntentSends: jest.fn(async () => []),
    syncShortcutTargets: jest.fn(async () => {}),
    initNotifications: jest.fn(async () => true),
    initBackgroundSync: jest.fn(async () => {}),
    notifyReceived: jest.fn(async () => {}),
    routeInboxEntry: jest.fn(async () => {}),
    realReceiveDeps: { clipboard: { setString: jest.fn(async () => true) } },
    pairingBundle: jest.fn(async () =>
      JSON.stringify({ cbor: 'aabb', name: 'me', device_id: 'bb'.repeat(16) }),
    ),
    generateQr: jest.fn(async () => 'data:image/png;base64,QUJD'),
    scanQr: jest.fn(async () =>
      JSON.stringify({ cbor: 'ccdd', name: 'peer', device_id: 'aa'.repeat(16) }),
    ),
  };
});

const engine = createEngine();
const mockedBundle = jest.mocked(pairingBundle);
const mockedQr = jest.mocked(generateQr);

const SAS = '111222';

function renderShell() {
  return render(
    <EngineProvider engine={engine}>
      {/* App.tsx wires exactly this: the pair slot into AppShell (R98). */}
      <AppShell pair={<PairingFlow />} />
    </EngineProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

// Drives the REAL shell (AppShell + TabBar) and the REAL wrapper, so a tab bar
// that forgets the pair entry or a wrapper that never displays the SAS both go
// red here -- the same reachability discipline AppShell.test.tsx applies to the
// background slot.
describe('QR pairing is reachable from the app shell', () => {
  it('mounts the flow lazily: no bundle fetch and no QR until the user asks', () => {
    renderShell();
    fireEvent.press(screen.getByText('pair'));
    expect(screen.getByText('Show QR')).toBeTruthy();
    expect(screen.getByText('Scan')).toBeTruthy();
    expect(mockedBundle).not.toHaveBeenCalled();
    expect(mockedQr).not.toHaveBeenCalled();
  });

  it('host half: shows the QR, displays the inbound SAS, confirm closes the flow', async () => {
    // startEngine registers the ONE engine.on; the pairing.sas branch on it is
    // what the host half of the flow reads (R91/R42 - no second subscription).
    await startEngine();
    renderShell();
    fireEvent.press(screen.getByText('pair'));

    fireEvent.press(screen.getByText('Show QR'));
    await waitFor(() =>
      expect(mockedQr).toHaveBeenCalledWith(expect.any(String), PAIRING_QR_SIZE),
    );
    expect(screen.getByLabelText('pairing-qr')).toBeTruthy();

    const handlers = (
      engine as unknown as { __handlers: Set<(e: DaakEvent) => void> }
    ).__handlers;
    act(() => {
      for (const h of handlers) h({ type: 'pairing.sas', peerDeviceId: 'aa'.repeat(16), sas: SAS });
    });
    // A SAS that is fetched and never shown is not pairing.
    await waitFor(() => expect(screen.getByText(SAS)).toBeTruthy());

    fireEvent.press(screen.getByLabelText('confirm'));
    expect(screen.getByText('Show QR')).toBeTruthy();
  });

  it('join half: scanning pairs through the engine and the SAS is shown', async () => {
    const pair = jest.spyOn(engine, 'pair');
    renderShell();
    fireEvent.press(screen.getByText('pair'));
    fireEvent.press(screen.getByText('Scan'));

    await waitFor(() => expect(screen.getByText('123456')).toBeTruthy());
    // The scanned payload must have reached engine.pair - never the raw string.
    expect(pair).toHaveBeenCalledWith('aa'.repeat(16), 'qr', 'ccdd');

    fireEvent.press(screen.getByLabelText('confirm'));
    expect(screen.getByText('Scan')).toBeTruthy();
  });
});
