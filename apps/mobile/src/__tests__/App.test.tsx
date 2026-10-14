import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { mockPlatformHost } from '../testPlatformMock';
import App from '../App';

// The Send tab's picker is INJECTED, so the app supplies it and the real barrel
// pulls the `Daak` TurboModule through @daak/core at module-eval time -- which
// throws under Jest with no bridge. Same reason the two module mocks below exist.
// The picker's own behaviour is packages/platform/src/share.test.ts's.
jest.mock('@daak/platform', () => mockPlatformHost());
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
  // App.tsx mounts the tapped-notification handlers. Returning a real
  // unsubscribe keeps the effect's cleanup honest; this file's subject is the
  // ROUTE the tap produces, and bootstrap's own dispatch is pinned in
  // notifications.test.ts.
  wireNotificationActions: jest.fn(() => () => {}),
  sendIntentItems: jest.fn(async () => {}),
  // The peer.incompatible fan-out off the ONE engine subscription. Every file
  // that renders App needs it: the import is undefined without it, and the
  // mount effect throws before the shell renders at all.
  onIncompatiblePeer: jest.fn(() => () => {}),
  postReceiveNotifications: jest.fn(async () => true),
  notificationGrant: jest.fn(() => true),
  recordNotificationGrant: jest.fn(),
}));

const { drainInbound, sendIntentItems, startEngineOnce, wireNotificationActions, engine } =
  jest.requireMock('../bootstrap');

let warn: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => warn.mockRestore());

describe('App', () => {
  // ASYNC, deliberately. App now reads the durable onboarding state BEFORE it
  // renders anything -- a first launch is decided by that read -- so a
  // synchronous assertion here races it and sees the loading view. The shell
  // assertion itself is unchanged; what it waits for is the keystore.
  it('boots and renders the tab shell', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('tab-devices')).toBeTruthy());
    expect(screen.getByTestId('tab-settings')).toBeTruthy();
    for (const gone of ['tab-send', 'tab-inbox', 'tab-transfers']) expect(screen.queryByTestId(gone)).toBeNull();
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
  // Same reason: the start is gated on the durable read, not on mount. The
  // owner still may not start the engine TWICE, and that is what this claims.
  it('starts the engine once through the idempotent owner', async () => {
    render(<App />);
    await waitFor(() => expect(startEngineOnce).toHaveBeenCalledTimes(1));
  });

  // R42: A RETURNING launch must not replay the onboarding name.
  //
  // The keystore keeps the name typed during FIRST-RUN onboarding. SQLite keeps
  // the name the user last typed anywhere, including in Settings. The engine
  // reads its own name from SQLite at start, so replaying the keystore copy
  // after that overwrites the newer name -- which is exactly the defect: a
  // rename made in Settings reverted on every relaunch.
  //
  // The mock's readOnboarding returns `name: 'Seawood Otter'`, so a replay
  // would call setDisplayName with that value and fail this assertion.
  it('does not replay the onboarding name on a returning launch', async () => {
    const rename = jest.spyOn(engine, 'setDisplayName');
    render(<App />);
    await waitFor(() => expect(startEngineOnce).toHaveBeenCalledTimes(1));
    // One more tick, so a rename fired AFTER the start had settled would still
    // be caught. The replay was chained onto the start promise.
    await act(async () => {});
    expect(rename).not.toHaveBeenCalled();
    rename.mockRestore();
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
    expect(screen.getByTestId('tab-devices')).toBeTruthy();
  });

  // The gap this closes: a share-sheet text/file item was staged natively and
  // nothing ever drained it, so sharing into Daak did nothing at all. Now both
  // arms land in the composer and the engine gets the real paths.
  it('holds a shared text and file on Devices, then seeds the thread the user picks', async () => {
    const pixel = { deviceId: 'aa'.repeat(16), name: 'Pixel 9', addr: '', online: true, presence: 'online', paired: true };
    const devices = jest.spyOn(engine, 'devices').mockResolvedValue([pixel]);
    const send = jest.spyOn(engine, 'send').mockResolvedValue({ transferId: 'bb'.repeat(16), queued: false });
    drainInbound.mockImplementationOnce(async (onItems: (i: unknown[]) => void) =>
      onItems([
        { kind: 'text', text: 'from the share sheet' },
        { kind: 'file', path: '/Documents/photo.png', name: 'photo.png' },
        // Already sent by bootstrap from its own subdir: must not be re-imported.
        { kind: 'intent-send', deviceId: 'aa', text: 'sent already' },
      ]),
    );
    render(<App />);
    expect(await screen.findByText('Pick a device for what you shared')).toBeTruthy();
    fireEvent.press(await screen.findByTestId('open-' + pixel.deviceId));
    expect(await screen.findByDisplayValue('from the share sheet')).toBeTruthy();
    expect(screen.getByText('photo.png')).toBeTruthy();
    fireEvent.press(await screen.findByTestId('send'));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send).toHaveBeenNthCalledWith(1, { peerDeviceId: pixel.deviceId, files: ['/Documents/photo.png'] });
    expect(send).toHaveBeenNthCalledWith(2, { peerDeviceId: pixel.deviceId, text: 'from the share sheet' });
    // The intent-send arm is bootstrap's, not a draft: no 'sent already' note.
    expect(screen.queryByDisplayValue('sent already')).toBeNull();
    devices.mockRestore();
    send.mockRestore();
  });

  // [Open] and [Share] were INSTALLED by initNotifications with nothing behind
  // them, so a tap was silently dropped. This drives the real App: the tap has
  // to reach the shell's Inbox route, not merely be dispatched in bootstrap.
  it('routes a tapped [Open] notification to the sender thread, or to Devices when no sender is named', async () => {
    const pixel = { deviceId: 'aa'.repeat(16), name: 'Pixel 9', addr: '', online: true, presence: 'online', paired: true };
    const devices = jest.spyOn(engine, 'devices').mockResolvedValue([pixel]);
    let open: ((payload: string) => void) | undefined;
    wireNotificationActions.mockImplementationOnce(
      (_reveal: (p: string) => void, o: (p: string) => void) => {
        open = o;
        return () => {};
      },
    );
    render(<App />);
    await act(async () => {});

    // Away from Devices, so arriving is the assertion.
    fireEvent.press(screen.getByTestId('tab-settings'));
    expect(await screen.findByTestId('save-name')).toBeTruthy();

    expect(open).toBeDefined();
    await act(async () => {
      open!(JSON.stringify({ peerDeviceId: pixel.deviceId }));
    });
    expect(await screen.findByTestId('thread-back')).toBeTruthy();

    await act(async () => {
      open!(JSON.stringify({ transferId: 'aa'.repeat(16) }));
    });
    expect(await screen.findByText('Your devices')).toBeTruthy();
    devices.mockRestore();
  });

  // Task 10: the onboarding flag lives in the Keychain and survives a reinstall,
  // but the Photos permission does not. A returning user is asked from App when
  // the OS status is undetermined. A first-launch user is asked by onboarding.
  it('asks for Photos access once for a returning user when the OS has not been asked', async () => {
    const platform = jest.requireMock('@daak/platform');
    // Every read says undetermined, so a second ask would be counted.
    platform.photosAccessStatus.mockResolvedValue('undetermined');
    platform.requestPhotosAccess.mockClear();
    try {
      render(<App />);
      await waitFor(() => expect(platform.requestPhotosAccess).toHaveBeenCalledTimes(1));
      await act(async () => {});
      expect(platform.requestPhotosAccess).toHaveBeenCalledTimes(1);
    } finally {
      platform.photosAccessStatus.mockResolvedValue('unavailable');
    }
  });

  it('does not ask for Photos access from App on a first launch', async () => {
    const platform = jest.requireMock('@daak/platform');
    const returning = { complete: true, name: 'Seawood Otter', discovery: true, alerts: true };
    platform.photosAccessStatus.mockResolvedValue('undetermined');
    platform.readOnboarding.mockResolvedValue({ complete: false, discovery: false, alerts: false });
    platform.requestPhotosAccess.mockClear();
    // The restore runs even when an assertion fails, so later tests keep the defaults.
    try {
      render(<App />);
      await act(async () => {});
      await act(async () => {});
      expect(platform.requestPhotosAccess).not.toHaveBeenCalled();
    } finally {
      platform.readOnboarding.mockResolvedValue(returning);
      platform.photosAccessStatus.mockResolvedValue('unavailable');
    }
  });

});
