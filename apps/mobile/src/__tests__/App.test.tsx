import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import App from '../App';

// The Send tab's picker is INJECTED, so the app supplies it and the real barrel
// pulls the `Daak` TurboModule through @daak/core at module-eval time -- which
// throws under Jest with no bridge. Same reason the two module mocks below exist.
// The picker's own behaviour is packages/platform/src/share.test.ts's.
jest.mock('@daak/platform', () => ({
  pickFiles: jest.fn(async () => []),
}));
// App now imports BackgroundSyncNotice, which reaches @daak/platform for the
// battery call. The real platform barrel pulls cbor-x (ESM) in through
// @daak/core and jest cannot parse it. The notice is a Pressable, so mocking it
// loses no coverage of the thing this file tests -- the shell, the owner, and
// the absence of a drain. backgroundWiring.test.tsx renders the real notice.
jest.mock('../BackgroundSyncNotice', () => ({
  BackgroundSyncNotice: () => null,
}));
// PairingFlow reaches @daak/platform (scanQr/generateQr) through the real
// barrel, which jest cannot parse; the flow itself is covered by
// pairingFlow.test.tsx, so this file mocks it away like BackgroundSyncNotice.
jest.mock('../PairingFlow', () => ({
  PairingFlow: () => null,
}));

// The real bootstrap reaches for the `Daak` TurboModule, which does not exist
// under Jest. Swap in the in-memory engine; that is the whole point of a smoke
// test -- the shell renders, the Rust edge is not exercised here.
jest.mock('../bootstrap', () => ({
  engine: jest.requireActual('@daak/ui').fakeEngine(),
  startEngine: async () => {},
  startEngineOnce: jest.fn(async () => {}),
  drainInbound: jest.fn(async () => {}),
  sendIntentItems: jest.fn(async () => {}),
  postReceiveNotifications: jest.fn(async () => true),
}));

const { drainInbound, sendIntentItems, startEngineOnce, engine } = jest.requireMock('../bootstrap');

let warn: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => warn.mockRestore());

describe('App', () => {
  it('boots and renders the tab shell', () => {
    render(<App />);
    expect(screen.getAllByText('Send').length).toBeGreaterThan(0);
    expect(screen.getByText('Devices')).toBeTruthy();
    expect(screen.getByText('Inbox')).toBeTruthy();
    expect(screen.getByText('Transfers')).toBeTruthy();
    expect(screen.getByText('Settings')).toBeTruthy();
  });

  it('drains the staged share inbox only AFTER the engine is up', async () => {
    render(<App />);
    // consumePendingShare is all-or-nothing natively: draining before
    // startEngineOnce resolves would hand back items with no engine to send
    // them, delete their metadata, and lose the bytes.
    expect(drainInbound).not.toHaveBeenCalled();
    await act(async () => {});
    expect(drainInbound).toHaveBeenCalledTimes(1);
  });

  it('leaves the engine untouched on mount', () => {
    const send = jest.spyOn(engine, 'send');
    render(<App />);
    expect(send).not.toHaveBeenCalled();
    expect(sendIntentItems).not.toHaveBeenCalled();
  });

  // Task 10 lands the lifecycle owner: something has to call startEngine, and
  // until this task it had NO production caller at all. startEngineOnce is the
  // idempotent wrapper -- a remount or Fast Refresh must not start a second
  // engine, which would be two identities and two discovery stacks on the LAN.
  // Note the contrast with the test above: the owner may START the engine, it
  // may not SEND through it, and it may not drain the share inbox.
  it('starts the engine once through the idempotent owner', () => {
    render(<App />);
    expect(startEngineOnce).toHaveBeenCalledTimes(1);
  });

  // An engine that never started shows a Dashboard with no devices, no banner
  // and no log -- and the banner the old comment relied on can never arrive,
  // because inbox.received requires a running engine. A corrupt database or a
  // taken data directory is exactly this. One warn line is the whole cost of
  // making it diagnosable in the field.
  it('says so out loud when the engine refuses to start', async () => {
    startEngineOnce.mockRejectedValueOnce(new Error('keystore rejected the key'));
    render(<App />);
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(String(warn.mock.calls[0][0])).toContain('start');
    // The log line is not the report: the user has to see it too, because
    // every list below is empty for the rest of the process and nothing else
    // on screen says why.
    await act(async () => {});
    expect(screen.getByText(/keystore rejected the key/)).toBeTruthy();
    // And the app still renders, rather than taking the whole UI down over a
    // fault the user may be able to fix.
    expect(screen.getByText('Devices')).toBeTruthy();
  });

  // The gap this closes: a share-sheet text/file item was staged natively and
  // nothing ever drained it, so sharing into Daak did nothing at all. Now both
  // arms land in the composer and the engine gets the real paths.
  it('routes a shared text and file into the Send composer', async () => {
    const send = jest.spyOn(engine, 'send').mockResolvedValue({ transferId: 'bb'.repeat(16), queued: true });
    drainInbound.mockImplementationOnce(async (onItems: (i: unknown[]) => void) =>
      onItems([
        { kind: 'text', text: 'from the share sheet' },
        { kind: 'file', path: '/Documents/photo.png', name: 'photo.png' },
        // Already sent by bootstrap from its own subdir: must not be re-imported.
        { kind: 'intent-send', deviceId: 'aa', text: 'sent already' },
      ]),
    );
    render(<App />);
    await waitFor(() => expect(screen.getByDisplayValue('from the share sheet')).toBeTruthy());
    expect(screen.getByText('photo.png')).toBeTruthy();
    fireEvent.press(await screen.findByLabelText('send'));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        peerDeviceId: expect.any(String),
        text: 'from the share sheet',
        files: ['/Documents/photo.png'],
      }),
    );
    // The intent-send arm is bootstrap's, not a draft: no 'sent already' note.
    expect(screen.queryByDisplayValue('sent already')).toBeNull();
  });

});
