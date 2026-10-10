import React from 'react';
import { StyleSheet } from 'react-native';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { DaakEngine, DaakEvent } from '@daak/core';
import { AppShell, EngineProvider, ToastProvider } from '@daak/ui';
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
const PEER_ID = 'aa'.repeat(16);

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
  // Same class as the missing bounded wait: the flow must never swallow the
  // reason a host screen failed to render. A fixed "hosting failed" tells the
  // user nothing and tells the next debugging round nothing either.
  it('shows the real hosting error, not a fixed string', async () => {
    mockedBundle.mockRejectedValueOnce(new Error('engine not started'));
    renderShell();
    fireEvent.press(screen.getByTestId('tab-devices'));
    fireEvent.press(screen.getByLabelText('pair-a-device'));
    fireEvent.press(screen.getByText('Show my code'));
    await waitFor(() => expect(screen.getByText(/engine not started/)).toBeTruthy());
  });

  it('mounts the flow lazily: no bundle fetch and no QR until the user asks', () => {
    renderShell();
    fireEvent.press(screen.getByTestId('tab-devices'));
      fireEvent.press(screen.getByLabelText('pair-a-device'));
    expect(screen.getByText('Show my code')).toBeTruthy();
    expect(screen.getByText('Scan a code')).toBeTruthy();
    expect(mockedBundle).not.toHaveBeenCalled();
    expect(mockedQr).not.toHaveBeenCalled();
  });

  it('bounds the host frame so PairingScreen can take its height', async () => {
    // The host QR was INVISIBLE on a phone: PairingScreen's own root is
    // ui.screen (flex: 1) and the wrapper had automatic height, so the whole
    // screen -- appbar, section and QR -- resolved to zero pixels. The pair
    // route then showed only the retry and back buttons, which reads as a
    // dead "Show my code". Reproduced on the iPhone 17 simulator. The desktop
    // wrapper already carries this flex; the phone's did not.
    renderShell();
    fireEvent.press(screen.getByTestId('tab-devices'));
    fireEvent.press(screen.getByLabelText('pair-a-device'));
    fireEvent.press(screen.getByText('Show my code'));
    await waitFor(() => expect(screen.getByLabelText('pairing-qr')).toBeTruthy());
    const frame = screen.getByTestId('pair-frame');
    expect(StyleSheet.flatten(frame.props.style)).toMatchObject({ flex: 1 });
  });

  it('host half: shows the QR and arms with NO camera scan', async () => {
    // startEngine registers the ONE engine.on; the pairing.sas branch on it is
    // what the host half of the flow reads (R91/R42 - no second subscription).
    await startEngine();
    renderShell();
    fireEvent.press(screen.getByTestId('tab-devices'));
      fireEvent.press(screen.getByLabelText('pair-a-device'));

    const armHostPairing = jest.spyOn(engine, 'armHostPairing');
    fireEvent.press(screen.getByText('Show my code'));
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
    await waitFor(() => expect(screen.getByText('111 222')).toBeTruthy());

    const confirmPairing = jest.spyOn(engine, 'confirmPairing');
    fireEvent.press(screen.getByLabelText('confirm'));
    // The SAS event named the peer, so confirming needs no other source.
    await waitFor(() => expect(confirmPairing).toHaveBeenCalledWith('aa'.repeat(16)));
    await waitFor(() => expect(screen.getByText('Show my code')).toBeTruthy());
  });

  // The engine keeps a new pairing pending. The screen offers a real answer to
  // the SAS compare: "They match" confirms it, "Does not match" removes it.
  it('offers They match and Does not match once a SAS is on screen', async () => {
    renderShell();
    fireEvent.press(screen.getByTestId('tab-devices'));
    fireEvent.press(screen.getByLabelText('pair-a-device'));
    fireEvent.press(screen.getByText('Scan a code'));
    await waitFor(() => expect(screen.getByText('123 456')).toBeTruthy());

    expect(screen.getByText('They match')).toBeTruthy();
    expect(screen.getByText('Does not match')).toBeTruthy();
  });

  it('confirms the pending pairing for the scanned peer when the user says it matches', async () => {
    const confirmPairing = jest.spyOn(engine, 'confirmPairing');
    renderShell();
    fireEvent.press(screen.getByTestId('tab-devices'));
    fireEvent.press(screen.getByLabelText('pair-a-device'));
    fireEvent.press(screen.getByText('Scan a code'));
    await waitFor(() => expect(screen.getByText('123 456')).toBeTruthy());

    fireEvent.press(screen.getByLabelText('confirm'));
    await waitFor(() => expect(confirmPairing).toHaveBeenCalledWith('aa'.repeat(16)));
    await waitFor(() => expect(screen.getByText('Scan a code')).toBeTruthy());
  });

  // A SAS that does not match must remove the pending pairing.
  it('removes the pending pairing when the user rejects a SAS that does not match', async () => {
    const revoke = jest.spyOn(engine, 'revokePairing');
    renderShell();
    fireEvent.press(screen.getByTestId('tab-devices'));
    fireEvent.press(screen.getByLabelText('pair-a-device'));
    fireEvent.press(screen.getByText('Scan a code'));
    await waitFor(() => expect(screen.getByText('123 456')).toBeTruthy());

    fireEvent.press(screen.getByLabelText('reject'));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('aa'.repeat(16)));
    expect(screen.queryByText('123 456')).toBeNull();
  });

  it('join half: scanning pairs through the engine and the SAS is shown', async () => {
    const pair = jest.spyOn(engine, 'pair');
    renderShell();
    fireEvent.press(screen.getByTestId('tab-devices'));
      fireEvent.press(screen.getByLabelText('pair-a-device'));
    fireEvent.press(screen.getByText('Scan a code'));

    await waitFor(() => expect(screen.getByText('123 456')).toBeTruthy());
    // The scanned payload must have reached engine.pair - never the raw string.
    // The fourth argument is the dialable address. This bundle has none, so it
    // is `undefined` and the joiner falls back to discovery (R42c/R42d).
    expect(pair).toHaveBeenCalledWith('aa'.repeat(16), 'qr', 'ccdd', undefined);

    fireEvent.press(screen.getByLabelText('confirm'));
    await waitFor(() => expect(screen.getByText('Scan a code')).toBeTruthy());
  });

  // Finding 2. A consumed or failed arm had NO way back: `acknowledge` returned
  // to 'choose' and nothing ever re-armed, so a user whose one scan was burnt by
  // a stray LAN connection had to restart the app. The fix is one button --
  // startHost() already re-arms, so pressing it again is the whole recovery.
  describe('host phase recovery', () => {
    it('offers a re-arm control BEFORE any SAS has arrived (the finding-1 case)', async () => {
      renderShell();
      fireEvent.press(screen.getByTestId('tab-devices'));
      fireEvent.press(screen.getByLabelText('pair-a-device'));
      fireEvent.press(screen.getByText('Show my code'));
      await waitFor(() => expect(screen.getByLabelText('pairing-qr')).toBeTruthy());

      // No SAS. This is the state a burnt arm leaves the host in: the QR is on
      // screen, nothing has paired, and the joiner is about to scan it.
      expect(screen.queryByText('111 222')).toBeNull();
      expect(screen.getByLabelText('host-retry')).toBeTruthy();
    });

    it('re-fetches the QR and arms a SECOND time when the retry control is pressed', async () => {
      await startEngine();
      renderShell();
      fireEvent.press(screen.getByTestId('tab-devices'));
      fireEvent.press(screen.getByLabelText('pair-a-device'));

      const armHostPairing = jest.spyOn(engine, 'armHostPairing');
      fireEvent.press(screen.getByText('Show my code'));
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
      fireEvent.press(screen.getByTestId('tab-devices'));
      fireEvent.press(screen.getByLabelText('pair-a-device'));
      fireEvent.press(screen.getByText('Show my code'));
      await waitFor(() => expect(screen.getByLabelText('pairing-qr')).toBeTruthy());

      const handlers = (
        engine as unknown as { __handlers: Set<(e: DaakEvent) => void> }
      ).__handlers;
      act(() => {
        for (const h of handlers)
          h({ type: 'pairing.sas', peerDeviceId: 'aa'.repeat(16), sas: SAS });
      });
      await waitFor(() => expect(screen.getByText('111 222')).toBeTruthy());

      expect(screen.getByLabelText('host-retry')).toBeTruthy();
    });
  });

  // A link join that fails reached the user as a SUCCESS. The measured screen
  // after `am start -d daak://pair?bundle=...` on the emulator showed the
  // button 'They match' and no SAS at all, above the error 'unknown
  // device bbbb...'. `acknowledge` clears the error, so the one label that
  // says pairing worked was on screen for a pairing that never happened, and
  // pressing it threw the message away.
  //
  // No confirmation button until there is a SAS to have matched. This is not
  // security gating: the engine commits the row either way. It only stops the
  // screen from claiming a match that has no second value.
  it('shows no confirmation button when a link join fails', async () => {
    const pair = jest.spyOn(engine, 'pair').mockRejectedValue(new Error('unknown device bbbb'));
    renderShell();
    fireEvent.press(screen.getByTestId('tab-devices'));
    fireEvent.press(screen.getByLabelText('pair-a-device'));
    fireEvent.press(screen.getByText('Scan a code'));
    await waitFor(() => expect(pair).toHaveBeenCalled());

    await waitFor(() => expect(screen.getByLabelText('pairing-error')).toBeTruthy());
    expect(screen.queryByLabelText('confirm')).toBeNull();
    pair.mockRestore();
  });
});

// The pairing panels use the words of the design. The flow is rendered without
// the shell, so these cases do not depend on how the shell reaches the route.
describe('the pairing flow uses the words of the design', () => {
  const renderFlow = () =>
    render(
      <EngineProvider engine={engine}>
        <ToastProvider>
          <PairingFlow />
        </ToastProvider>
      </EngineProvider>,
    );
  const handlers = () =>
    (engine as unknown as { __handlers: Set<(e: DaakEvent) => void> }).__handlers;

  it('shows the lead and both choices before any choice', () => {
    renderFlow();
    expect(screen.getByText('Open Daak on the other device, then pick how you want to join up.')).toBeTruthy();
    expect(screen.getByText('Show my code')).toBeTruthy();
    expect(screen.getByText('Scan a code')).toBeTruthy();
    expect(screen.queryByText('Show QR')).toBeNull();
    expect(screen.queryByText('Pair with another Daak device')).toBeNull();
  });

  it('shows "Making your code…" while the bundle is fetched', async () => {
    mockedBundle.mockReturnValueOnce(new Promise(() => {}));
    renderFlow();
    fireEvent.press(screen.getByText('Show my code'));
    expect(await screen.findByText('Making your code…')).toBeTruthy();
    expect(screen.getByText('Show this to the other device')).toBeTruthy();
    expect(screen.queryByLabelText('pairing-qr')).toBeNull();
  });

  // Review Focus 3. The host reads the number out loud. A leading zero counts.
  it('shows the SAS with a space and leading zeros, and confirms with "They match"', async () => {
    await startEngine();
    renderFlow();
    fireEvent.press(screen.getByText('Show my code'));
    await waitFor(() => expect(screen.getByLabelText('pairing-qr')).toBeTruthy());
    act(() => {
      for (const h of handlers()) h({ type: 'pairing.sas', peerDeviceId: 'aa'.repeat(16), sas: '004217' });
    });
    expect(await screen.findByText('004 217')).toBeTruthy();
    expect(screen.getByText('Read this number out loud. Check it matches theirs.')).toBeTruthy();
    fireEvent.press(screen.getByTestId('pair-why-toggle'));
    expect(screen.getByText('If both screens show 004 217, only your two devices are in the room.')).toBeTruthy();
    expect(screen.getByText('Does not match')).toBeTruthy();
    expect(screen.queryByText('Finish pairing')).toBeNull();
    // "They match" is the confirm. The event named the peer, so the id is known.
    const confirmPairing = jest.spyOn(engine, 'confirmPairing');
    fireEvent.press(screen.getByLabelText('confirm'));
    await waitFor(() => expect(confirmPairing).toHaveBeenCalledWith('aa'.repeat(16)));
    await waitFor(() => expect(screen.getByText('Show my code')).toBeTruthy());
  });

  // The engine keeps the pairing pending. A failed confirm must not look like a
  // success and must not lose the number the user is still comparing.
  it('keeps the number and shows an error when confirming the pairing fails', async () => {
    jest.spyOn(engine, 'confirmPairing').mockRejectedValueOnce(new Error('no pending pairing to confirm'));
    renderFlow();
    fireEvent.press(screen.getByText('Scan a code'));
    await waitFor(() => expect(screen.getByText('123 456')).toBeTruthy());
    fireEvent.press(screen.getByLabelText('confirm'));
    expect(await screen.findByText(/no pending pairing to confirm/)).toBeTruthy();
    expect(screen.getByText("We couldn't finish pairing.")).toBeTruthy();
    expect(screen.getByText('123 456')).toBeTruthy();
    expect(screen.getByLabelText('confirm')).toBeTruthy();
  });

  // Commit fffa68b. A link only asks. The user taps Pair before the engine is called.
  it('asks before it joins a link, then shows "Reading their code…" until the engine answers', async () => {
    let release!: (v: { sas: string }) => void;
    const pair = jest.spyOn(engine, 'pair').mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const bundle = JSON.stringify({ cbor: 'aabbcc', name: 'Pixel 9', device_id: 'aa'.repeat(16) });
    render(
      <EngineProvider engine={engine}>
        <PairingFlow bundle={bundle} />
      </EngineProvider>,
    );
    expect(screen.getByText('Pair with Pixel 9?')).toBeTruthy();
    expect(pair).not.toHaveBeenCalled();
    fireEvent.press(screen.getByLabelText('link-pair-confirm'));
    expect(await screen.findByText('Reading their code…')).toBeTruthy();
    await act(async () => {
      release({ sas: '482917' });
    });
    expect(await screen.findByText('482 917')).toBeTruthy();
    expect(screen.getByLabelText('confirm')).toBeTruthy();
  });

  it('join: shows the camera heading while the scanner is open', async () => {
    mockedScan.mockReturnValueOnce(new Promise(() => {}));
    renderFlow();
    fireEvent.press(screen.getByText('Scan a code'));
    expect(await screen.findByText('Point the camera at their square')).toBeTruthy();
    expect(screen.getByText('Hold steady for a second.')).toBeTruthy();
  });

  it('join: shows "Reading their code…" after the scan and before the SAS', async () => {
    let release!: (v: { sas: string }) => void;
    jest.spyOn(engine, 'pair').mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    renderFlow();
    fireEvent.press(screen.getByText('Scan a code'));
    expect(await screen.findByText('Reading their code…')).toBeTruthy();
    expect(screen.queryByText('Hold steady for a second.')).toBeNull();
    await act(async () => {
      release({ sas: '482917' });
    });
    expect(await screen.findByText('482 917')).toBeTruthy();
    expect(screen.getByText('Their screen shows the same number. Check it matches yours.')).toBeTruthy();
    expect(screen.queryByText('Reading their code…')).toBeNull();
  });

  it('shows the design error and runs the scan again on Try again', async () => {
    mockedScan.mockRejectedValueOnce(new Error('camera denied'));
    renderFlow();
    fireEvent.press(screen.getByText('Scan a code'));
    expect(await screen.findByText("We couldn't read that code.")).toBeTruthy();
    expect(screen.getByText(/camera denied/)).toBeTruthy();
    fireEvent.press(screen.getByLabelText('pair-retry'));
    await waitFor(() => expect(mockedScan).toHaveBeenCalledTimes(2));
  });

  // Design v3. "Does not match" cancels the pairing, shows the toast "Pairing
  // cancelled", and returns to the choice. The engine trusts nobody.
  it('cancels the pairing on "Does not match" and returns to the choice with a toast', async () => {
    const revoke = jest.spyOn(engine, 'revokePairing');
    const confirmPairing = jest.spyOn(engine, 'confirmPairing');
    renderFlow();
    fireEvent.press(screen.getByText('Scan a code'));
    await waitFor(() => expect(screen.getByText('123 456')).toBeTruthy());
    expect(screen.queryByTestId('toast')).toBeNull();
    fireEvent.press(screen.getByLabelText('reject'));
    expect(await screen.findByText('Pairing cancelled')).toBeTruthy();
    expect(screen.getByTestId('toast-text')).toBeTruthy();
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(confirmPairing).not.toHaveBeenCalled();
    expect(screen.queryByText('123 456')).toBeNull();
    expect(screen.getByText('Show my code')).toBeTruthy();
    expect(screen.getByText('Scan a code')).toBeTruthy();
    // The old inline note is gone. The toast is the only place the text shows.
    expect(screen.queryByTestId('pairing-cancelled')).toBeNull();
  });

  // `reject` returns to the choose pane. That pane must show a failed removal.
  it('shows the error on the choose pane when removing a rejected pairing fails', async () => {
    jest.spyOn(engine, 'revokePairing').mockRejectedValueOnce(new Error('store is locked'));
    renderFlow();
    // The scan names the peer (`joinWithScan` returns `peerDeviceId`), so the
    // reject control can remove the pending pairing. No event is needed.
    fireEvent.press(screen.getByText('Scan a code'));
    await waitFor(() => expect(screen.getByText('123 456')).toBeTruthy());
    fireEvent.press(screen.getByLabelText('reject'));
    expect(await screen.findByText(/store is locked/)).toBeTruthy();
    expect(screen.getByText("We couldn't remove that pairing.")).toBeTruthy();
    // The pane is the choose pane: both choices show.
    expect(screen.getByText('Show my code')).toBeTruthy();
    expect(screen.getByText('Scan a code')).toBeTruthy();
  });

  it('shows the design error and fetches the bundle again when the host failed', async () => {
    mockedBundle.mockRejectedValueOnce(new Error('engine not started'));
    renderFlow();
    fireEvent.press(screen.getByText('Show my code'));
    expect(await screen.findByText(/engine not started/)).toBeTruthy();
    expect(screen.getByText("We couldn't make your code.")).toBeTruthy();
    expect(screen.queryByLabelText('pairing-qr')).toBeNull();
    fireEvent.press(screen.getByLabelText('pair-retry'));
    await waitFor(() => expect(mockedBundle).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByLabelText('pairing-qr')).toBeTruthy());
  });
});

// Leaving the pair route is "Does not match". A number the user never answered is
// a pending pairing, and it must not linger until a restart.
describe('leaving the pair route rejects a pending pairing', () => {
  const renderFlow = () =>
    render(
      <EngineProvider engine={engine}>
        <ToastProvider>
          <PairingFlow />
        </ToastProvider>
      </EngineProvider>,
    );

  it('revokes once, with the peer id, when it unmounts with a number on screen', async () => {
    const revoke = jest.spyOn(engine, 'revokePairing');
    const view = renderFlow();
    fireEvent.press(screen.getByText('Scan a code'));
    await waitFor(() => expect(screen.getByText('123 456')).toBeTruthy());
    // A re-render with the same props does not revoke.
    view.rerender(
      <EngineProvider engine={engine}>
        <ToastProvider>
          <PairingFlow />
        </ToastProvider>
      </EngineProvider>,
    );
    expect(revoke).not.toHaveBeenCalled();
    view.unmount();
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(PEER_ID);
  });

  it('does not revoke after "They match" succeeded', async () => {
    const revoke = jest.spyOn(engine, 'revokePairing');
    const confirmPairing = jest.spyOn(engine, 'confirmPairing');
    const view = renderFlow();
    fireEvent.press(screen.getByText('Scan a code'));
    await waitFor(() => expect(screen.getByText('123 456')).toBeTruthy());
    fireEvent.press(screen.getByLabelText('confirm'));
    await waitFor(() => expect(confirmPairing).toHaveBeenCalledWith(PEER_ID));
    await waitFor(() => expect(screen.getByText('Show my code')).toBeTruthy());
    view.unmount();
    expect(revoke).not.toHaveBeenCalled();
  });

  it('revokes on unmount when "They match" failed, because the pairing is still pending', async () => {
    const revoke = jest.spyOn(engine, 'revokePairing');
    jest.spyOn(engine, 'confirmPairing').mockRejectedValueOnce(new Error('no pending pairing to confirm'));
    const view = renderFlow();
    fireEvent.press(screen.getByText('Scan a code'));
    await waitFor(() => expect(screen.getByText('123 456')).toBeTruthy());
    fireEvent.press(screen.getByLabelText('confirm'));
    expect(await screen.findByText(/no pending pairing to confirm/)).toBeTruthy();
    view.unmount();
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(PEER_ID);
  });

  it('does not revoke a second time on unmount after "Does not match"', async () => {
    const revoke = jest.spyOn(engine, 'revokePairing');
    const view = renderFlow();
    fireEvent.press(screen.getByText('Scan a code'));
    await waitFor(() => expect(screen.getByText('123 456')).toBeTruthy());
    fireEvent.press(screen.getByLabelText('reject'));
    expect(await screen.findByText('Pairing cancelled')).toBeTruthy();
    expect(revoke).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('does not revoke when it unmounts before any number', async () => {
    const revoke = jest.spyOn(engine, 'revokePairing');
    const view = renderFlow();
    fireEvent.press(screen.getByText('Show my code'));
    view.unmount();
    expect(revoke).not.toHaveBeenCalled();
    const second = renderFlow();
    second.unmount();
    expect(revoke).not.toHaveBeenCalled();
  });

  it('revokes the host peer named by the pairing.sas event when it unmounts', async () => {
    await startEngine();
    const revoke = jest.spyOn(engine, 'revokePairing');
    const view = renderFlow();
    fireEvent.press(screen.getByText('Show my code'));
    await waitFor(() => expect(screen.getByLabelText('pairing-qr')).toBeTruthy());
    act(() => {
      for (const h of (engine as unknown as { __handlers: Set<(e: DaakEvent) => void> }).__handlers) {
        h({ type: 'pairing.sas', peerDeviceId: 'bb'.repeat(16), sas: '004217' });
      }
    });
    expect(await screen.findByText('004 217')).toBeTruthy();
    view.unmount();
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith('bb'.repeat(16));
  });

  it('swallows a failed revoke on unmount', async () => {
    jest.spyOn(engine, 'revokePairing').mockRejectedValueOnce(new Error('store is locked'));
    const view = renderFlow();
    fireEvent.press(screen.getByText('Scan a code'));
    await waitFor(() => expect(screen.getByText('123 456')).toBeTruthy());
    expect(() => view.unmount()).not.toThrow();
    await act(async () => {
      await Promise.resolve();
    });
  });
});

// The shared fixture is the FFI's REAL output: crates/daak-ffi/tests/smoke.rs
// asserts that it equals ffi_event_json(to_pairing_sas_event(...)), so this
// case fails if the native side ever sends an empty peer id again. That is
// exactly what happened: the host rendered NO confirm control, and a
// host-initiated QR pairing never became trusted on the host. No simulator or
// emulator is needed to catch it now.
describe('the FFI fixture drives the host half', () => {
  it('confirms with the peer id that the native side actually sends', async () => {
    const fixture = JSON.parse(
      readFileSync(
        join(__dirname, '..', '..', '..', '..', 'packages', 'core', 'test', 'fixtures', 'daak-events.json'),
        'utf8',
      ),
    ) as { PairingSas: { peerDeviceId: string; sas: string } };
    const event = fixture.PairingSas;
    expect(event.peerDeviceId).not.toBe('');

    await startEngine();
    renderShell();
    fireEvent.press(screen.getByTestId('tab-devices'));
    fireEvent.press(screen.getByLabelText('pair-a-device'));
    fireEvent.press(screen.getByText('Show my code'));
    await waitFor(() => expect(screen.getByLabelText('pairing-qr')).toBeTruthy());

    const handlers = (
      engine as unknown as { __handlers: Set<(e: DaakEvent) => void> }
    ).__handlers;
    act(() => {
      for (const h of handlers)
        h({ type: 'pairing.sas', peerDeviceId: event.peerDeviceId, sas: event.sas });
    });
    // The control exists ONLY when the event named the peer.
    await waitFor(() => expect(screen.getByLabelText('confirm')).toBeTruthy());
    const confirmPairing = jest.spyOn(engine, 'confirmPairing');
    fireEvent.press(screen.getByLabelText('confirm'));
    await waitFor(() => expect(confirmPairing).toHaveBeenCalledWith(event.peerDeviceId));
  });
});

