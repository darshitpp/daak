import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';
import App from '../App';

// App now imports BackgroundSyncNotice, which reaches @daak/platform for the
// battery call. The real platform barrel pulls cbor-x (ESM) in through
// @daak/core and jest cannot parse it. The notice is a Pressable, so mocking it
// loses no coverage of the thing this file tests -- the shell, the owner, and
// the absence of a drain. backgroundWiring.test.tsx renders the real notice.
jest.mock('../BackgroundSyncNotice', () => ({
  BackgroundSyncNotice: () => null,
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
    expect(screen.getByText('dashboard')).toBeTruthy();
  });

  it('does NOT drain the staged share inbox on mount', () => {
    render(<App />);
    // R22 regression guard. App MUST NOT drain on mount. consumePendingShare is
    // all-or-nothing natively: draining here would delete the batch that names
    // a shared text/file item while its bytes sit unreferenced, i.e. silent
    // data loss on the inbound path. Nothing consumes those items yet (Task 11
    // owns the composer route), so the staged batch is the correct resting
    // state. Task 7/9 own the intent-send arm. Re-adding the effect fails here.
    expect(drainInbound).not.toHaveBeenCalled();
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
    // And the app still renders, rather than taking the whole UI down over a
    // fault the user may be able to fix.
    expect(screen.getByText('dashboard')).toBeTruthy();
  });
});
