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
const mockedScan = jest.mocked(scanQr);

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

  it('host half: shows the QR and arms with NO camera scan', async () => {
    // startEngine registers the ONE engine.on; the pairing.sas branch on it is
    // what the host half of the flow reads (R91/R42 - no second subscription).
    await startEngine();
    renderShell();
    fireEvent.press(screen.getByText('pair'));

    const armHostPairing = jest.spyOn(engine, 'armHostPairing');
    fireEvent.press(screen.getByText('Show QR'));
    await waitFor(() =>
      expect(mockedQr).toHaveBeenCalledWith(expect.any(String), PAIRING_QR_SIZE),
    );
    // Spec 3.3 Mode A: the host shows its QR and arms. The JOINER is the only
    // side that scans, so the host must never open a camera -- and the arm must
    // not depend on a scanned payload no real device can produce. This asserts
    // the arm happens with scanQr NEVER called, which is the thing the previous
    // two passes got wrong in different ways.
    expect(screen.getByLabelText('pairing-qr')).toBeTruthy();
    await waitFor(() => expect(armHostPairing).toHaveBeenCalledTimes(1));
    expect(mockedScan).not.toHaveBeenCalled();
    // The arm names no bundle: the host has none, and the engine learns the
    // joiner's identity in-band. Passing a scanned bundle here is the bug.
    expect(armHostPairing).toHaveBeenCalledWith();
    expect(screen.getByLabelText('pairing-qr')).toBeTruthy();
    // No host-side camera control to press.
    expect(screen.queryByLabelText('scan-joiner')).toBeNull();
    expect(screen.queryByLabelText('scan')).toBeNull();

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

  // C2: the button is NOT a security gate. The engine auto-commits the
  // pairing row before the SAS is even computed, so "Confirm" promised a
  // control the user does not have. The honest label says what pressing it
  // does: acknowledge the matching SAS and leave the flow.
  it('labels the final button as an acknowledgement, not as gating a pairing', async () => {
    renderShell();
    fireEvent.press(screen.getByText('pair'));
    fireEvent.press(screen.getByText('Scan'));
    await waitFor(() => expect(screen.getByText('123456')).toBeTruthy());

    expect(screen.queryByText('Confirm')).toBeNull();
    expect(screen.getByText('SAS matched - Done')).toBeTruthy();
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

  // Finding 2. A consumed or failed arm had NO way back: `acknowledge` returned
  // to 'choose' and nothing ever re-armed, so a user whose one scan was burnt by
  // a stray LAN connection had to restart the app. The fix is one button --
  // startHost() already re-arms, so pressing it again is the whole recovery.
  describe('host phase recovery', () => {
    it('offers a re-arm control BEFORE any SAS has arrived (the finding-1 case)', async () => {
      renderShell();
      fireEvent.press(screen.getByText('pair'));
      fireEvent.press(screen.getByText('Show QR'));
      await waitFor(() => expect(screen.getByLabelText('pairing-qr')).toBeTruthy());

      // No SAS. This is the state a burnt arm leaves the host in: the QR is on
      // screen, nothing has paired, and the joiner is about to scan it.
      expect(screen.queryByText('111222')).toBeNull();
      expect(screen.getByLabelText('host-retry')).toBeTruthy();
    });

    it('re-fetches the QR and arms a SECOND time when the retry control is pressed', async () => {
      await startEngine();
      renderShell();
      fireEvent.press(screen.getByText('pair'));

      const armHostPairing = jest.spyOn(engine, 'armHostPairing');
      fireEvent.press(screen.getByText('Show QR'));
      await waitFor(() => expect(armHostPairing).toHaveBeenCalledTimes(1));
      expect(mockedQr).toHaveBeenCalledTimes(1);

      fireEvent.press(screen.getByLabelText('host-retry'));

      // The arm is REPLACEABLE, so a second press must reach the engine again --
      // that is the whole recovery. A QR re-render alone would not re-arm.
      await waitFor(() => expect(armHostPairing).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(mockedQr).toHaveBeenCalledTimes(2));
      expect(armHostPairing).toHaveBeenCalledWith();
    });

    it('keeps the retry control available after a SAS arrived', async () => {
      await startEngine();
      renderShell();
      fireEvent.press(screen.getByText('pair'));
      fireEvent.press(screen.getByText('Show QR'));
      await waitFor(() => expect(screen.getByLabelText('pairing-qr')).toBeTruthy());

      const handlers = (
        engine as unknown as { __handlers: Set<(e: DaakEvent) => void> }
      ).__handlers;
      act(() => {
        for (const h of handlers)
          h({ type: 'pairing.sas', peerDeviceId: 'aa'.repeat(16), sas: SAS });
      });
      await waitFor(() => expect(screen.getByText(SAS)).toBeTruthy());

      expect(screen.getByLabelText('host-retry')).toBeTruthy();
    });
  });
});
