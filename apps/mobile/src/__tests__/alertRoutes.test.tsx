import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { DaakEngine } from '@daak/core';
import { mockPlatformHost } from '../testPlatformMock';
import App from '../App';

// The prototype's two BLOCKING screens -- update-required and cant-reach --
// through the real App, with the real shell routing them.
//
// They were screens in packages/ui with no production caller: nothing routed
// to either, so every peer on a different protocol version and every asleep
// peer on a healthy LAN produced an app that said nothing about it. What these
// tests pin is the ROUTE and its TRUTHFULNESS -- which engine answers open a
// screen, which do not, and what happens when the user backs out.
jest.mock('@daak/platform', () => mockPlatformHost());
jest.mock('../BackgroundSyncNotice', () => ({ BackgroundSyncNotice: () => null }));
jest.mock('../PairingFlow', () => ({ PairingFlow: () => null }));

// The incompatible-peer fan-out is the only thing here that has to be DRIVEN
// rather than merely present, so the mock captures the callback instead of
// discarding it. Same hoisting constraint as the other factories: only
// mock-prefixed bindings may be referenced.
let mockOnIncompatiblePeer: ((peer: unknown) => void) | undefined;
jest.mock('../bootstrap', () => ({
  engine: jest.requireActual('@daak/ui').fakeEngine(),
  startEngine: async () => {},
  startEngineOnce: jest.fn(async () => {}),
  drainInbound: jest.fn(async () => {}),
  wireNotificationActions: jest.fn(() => () => {}),
  sendIntentItems: jest.fn(async () => {}),
  postReceiveNotifications: jest.fn(async () => true),
  notificationGrant: jest.fn(() => true),
  recordNotificationGrant: jest.fn(),
  onIncompatiblePeer: jest.fn((cb: (peer: unknown) => void) => {
    mockOnIncompatiblePeer = cb;
    return () => {
      mockOnIncompatiblePeer = undefined;
    };
  }),
}));

const { engine } = jest.requireMock('../bootstrap') as { engine: DaakEngine };

const peerA = { deviceId: 'aa'.repeat(16), name: 'Pixel 9', addr: '192.168.1.9:40001' };
const peerB = { deviceId: 'bb'.repeat(16), name: 'ThinkPad', addr: '192.168.1.4:40001' };

const outOfStep = (over: { peerDeviceId?: string; peerName?: string; peerVersion?: number } = {}) => ({
  peerDeviceId: over.peerDeviceId ?? peerA.deviceId,
  peerName: over.peerName ?? peerA.name,
  peerVersion: over.peerVersion ?? 2,
  ourVersion: 1,
});

/** Delivers a peer.incompatible through the captured fan-out. */
async function announce(peer: ReturnType<typeof outOfStep>) {
  await act(async () => {
    mockOnIncompatiblePeer?.(peer);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockOnIncompatiblePeer = undefined;
  // A returning user: the durable read resolves complete, so App renders the
  // shell rather than onboarding. Nothing else in this file is about the flow.
  jest
    .spyOn(engine, 'selfProfile')
    .mockResolvedValue({ name: 'Test Device', baseName: 'Test Device', deviceId: 'dd'.repeat(16) });
});

afterEach(() => jest.restoreAllMocks());

describe('update-required', () => {
  // THE reason this screen exists. A peer on a different protocol version is
  // SKIPPED by the engine rather than listed, so without this the only symptom
  // of a version mismatch is a network that looks empty -- indistinguishable
  // from nobody being home.
  it('opens when the engine reports an incompatible peer', async () => {
    render(<App />);
    await screen.findByTestId('tab-devices');
    await announce(outOfStep());
    expect(await screen.findByText('Daak needs a quick update')).toBeTruthy();
    // The REAL numbers, not the prototype's "0.4.2 (build 1180)".
    expect(screen.getByText('File mover version 2')).toBeTruthy();
    expect(screen.getByText('File mover version 1')).toBeTruthy();
  });

  // A peer announces on a timer, so this event repeats for as long as the peer
  // stays out of step. "Remind me later" that survives a few seconds is not a
  // dismissal at all.
  it('does not re-open for a peer the user already dismissed', async () => {
    render(<App />);
    await screen.findByTestId('tab-devices');
    await announce(outOfStep());
    fireEvent.press(await screen.findByLabelText('update-dismiss'));
    expect(screen.queryByText('Daak needs a quick update')).toBeNull();

    await announce(outOfStep());
    expect(screen.queryByText('Daak needs a quick update')).toBeNull();
  });

  // A second out-of-step peer is a NEW fact and does open the screen, and it
  // has to be LISTED -- the prototype's "Also out of step" block, which was
  // dead markup because nothing ever produced a second entry.
  it('opens again for a different peer, and lists both', async () => {
    render(<App />);
    await screen.findByTestId('tab-devices');
    await announce(outOfStep());
    fireEvent.press(await screen.findByLabelText('update-dismiss'));

    await announce(outOfStep({ peerDeviceId: peerB.deviceId, peerName: peerB.name, peerVersion: 3 }));
    expect(await screen.findByText('Also out of step')).toBeTruthy();
    expect(screen.getByText('File mover version 3')).toBeTruthy();
  });

  // A button that only dismisses the screen it is on is a dead button: the
  // user is told to go to Settings and stays where they were.
  it('routes Open Settings to the Settings tab', async () => {
    render(<App />);
    await screen.findByTestId('tab-devices');
    await announce(outOfStep());
    fireEvent.press(await screen.findByLabelText('update-settings'));
    expect(await screen.findByLabelText('save-name')).toBeTruthy();
    expect(screen.queryByText('Daak needs a quick update')).toBeNull();
  });
});

describe('cant-reach', () => {
  // It was an effect once, running devices() on every launch and routing here
  // whenever the list came back empty. Daak answers "nobody" on a healthy LAN
  // whenever the other device is asleep, so that put a wall in front of every
  // user instead of in front of a real failure.
  it('is not shown just because nobody is on the network', async () => {
    jest.spyOn(engine, 'devices').mockResolvedValue([]);
    render(<App />);
    await screen.findByTestId('tab-devices');
    await act(async () => {});
    expect(screen.queryByText("Daak can't reach any devices")).toBeNull();
  });

  // The prototype's Settings affordance (prototypes/index.html:1237) is what
  // opens it, and only that.
  it('opens from the Settings check-connection button when the network is empty', async () => {
    jest.spyOn(engine, 'devices').mockResolvedValue([]);
    render(<App />);
    fireEvent.press(await screen.findByText('Settings'));
    fireEvent.press(await screen.findByLabelText('settings-check-connection'));
    expect(await screen.findByText("Daak can't reach any devices")).toBeTruthy();
  });

  // Same button, same affordance, the other honest answer: there IS somebody
  // there, so the devices tab was already right and the screen must not appear
  // beside a populated device list.
  it('stays on Settings when the check finds devices', async () => {
    jest.spyOn(engine, 'devices').mockResolvedValue([peerA]);
    render(<App />);
    fireEvent.press(await screen.findByText('Settings'));
    fireEvent.press(await screen.findByLabelText('settings-check-connection'));
    await act(async () => {});
    expect(screen.queryByText("Daak can't reach any devices")).toBeNull();
    expect(screen.getByLabelText('save-name')).toBeTruthy();
  });

  // "Nobody is home" and "the check itself failed" are different problems, and
  // a rejection is NOT evidence that nobody is there. The screen says which.
  it('names a failed check as a failed check', async () => {
    // PERSISTENT, not mockRejectedValueOnce: the Devices screen asks the engine
    // for a list on its first render, so a one-shot rejection is spent before
    // the check button is ever pressed -- and a test that then passes against a
    // stale screen is pinning nothing.
    jest.spyOn(engine, 'devices').mockRejectedValue(new Error('discovery socket refused'));
    render(<App />);
    fireEvent.press(await screen.findByText('Settings'));
    fireEvent.press(await screen.findByLabelText('settings-check-connection'));
    // NOT "Daak can't reach any devices": a rejection is not evidence that the
    // network is empty, and the title has to stop claiming it is.
    expect(await screen.findByText('Daak could not finish the search')).toBeTruthy();
    expect(screen.queryByText("Daak can't reach any devices")).toBeNull();
    expect(screen.getByText('What the check said')).toBeTruthy();
    expect(screen.getByText('discovery socket refused')).toBeTruthy();
  });

  // The queue is the prototype's "Waiting to send" block. It is the REAL
  // outbox: a made-up queue would prove nothing about a screen whose whole
  // promise is that nothing is lost.
  it('shows real pending outbox rows and nothing that has finished', async () => {
    jest.spyOn(engine, 'devices').mockResolvedValue([]);
    jest.spyOn(engine, 'listTransfers').mockResolvedValue([
      { transferId: 'c1'.repeat(16), peerDeviceId: peerA.deviceId, direction: 'out', kind: 'media',
        state: 'queued', bytesDone: 0, bytesTotal: 2048, itemCount: 1, updatedAt: 5 },
      { transferId: 'c2'.repeat(16), peerDeviceId: peerB.deviceId, direction: 'out', kind: 'text',
        state: 'done', bytesDone: 10, bytesTotal: 10, itemCount: 1, updatedAt: 6 },
    ]);
    render(<App />);
    fireEvent.press(await screen.findByText('Settings'));
    fireEvent.press(await screen.findByLabelText('settings-check-connection'));
    expect(await screen.findByText('Waiting to send')).toBeTruthy();
    expect(screen.getAllByTestId('cant-reach-queued')).toHaveLength(1);
    // The engine's summary carries no display name, so the label is the peer id
    // -- real, and honest about being an id.
    expect(screen.getByText('To ' + peerA.deviceId.slice(0, 8))).toBeTruthy();
  });

  // Retry has to RE-ASK, not clear the flag: the peer may have come back, and
  // a retry that only re-renders would strand the user on a stale screen.
  it('asks the engine again on retry', async () => {
    const devices = jest.spyOn(engine, 'devices').mockResolvedValue([]);
    const transfers = jest.spyOn(engine, 'listTransfers').mockResolvedValue([]);
    render(<App />);
    fireEvent.press(await screen.findByText('Settings'));
    fireEvent.press(await screen.findByLabelText('settings-check-connection'));
    await screen.findByText("Daak can't reach any devices");
    const before = devices.mock.calls.length;
    const transfersBefore = transfers.mock.calls.length;

    devices.mockResolvedValue([peerA]);
    fireEvent.press(screen.getByLabelText('cant-reach-retry'));
    await waitFor(() => expect(devices.mock.calls.length).toBeGreaterThan(before));
    // Somebody is there now, so the screen goes away on its own.
    await waitFor(() => expect(screen.queryByText("Daak can't reach any devices")).toBeNull());

    // And a check that still finds nobody re-reads the outbox too: a retry
    // showing the PREVIOUS failure's queue is a screen claiming to describe the
    // present.
    devices.mockResolvedValue([]);
    fireEvent.press(await screen.findByLabelText('settings-check-connection'));
    await screen.findByText("Daak can't reach any devices");
    const afterOk = transfers.mock.calls.length;
    fireEvent.press(screen.getByLabelText('cant-reach-retry'));
    await waitFor(() => expect(transfers.mock.calls.length).toBeGreaterThan(afterOk));
  });

  // A retry that SUCCEEDS must refresh the queue too. This is the path that used
  // to return early on a non-empty device list, so the outbox kept the last
  // failed check's rows: the user tapped Retry, devices came back, and the queue
  // they were being sent back to was never re-read.
  it('re-reads the outbox on a retry that finds devices', async () => {
    const devices = jest.spyOn(engine, 'devices').mockResolvedValue([]);
    const transfers = jest.spyOn(engine, 'listTransfers').mockResolvedValue([]);
    render(<App />);
    fireEvent.press(await screen.findByText('Settings'));
    fireEvent.press(await screen.findByLabelText('settings-check-connection'));
    await screen.findByText("Daak can't reach any devices");

    const before = transfers.mock.calls.length;
    devices.mockResolvedValue([peerA]);
    fireEvent.press(screen.getByLabelText('cant-reach-retry'));
    // React 19: the retry resolves devices() on a microtask outside act.
    await act(async () => {});
    await waitFor(() => expect(screen.queryByText("Daak can't reach any devices")).toBeNull());
    expect(transfers.mock.calls.length).toBeGreaterThan(before);
  });

  it('routes Open Settings to the Settings tab', async () => {
    jest.spyOn(engine, 'devices').mockResolvedValue([]);
    render(<App />);
    fireEvent.press(await screen.findByText('Settings'));
    fireEvent.press(await screen.findByLabelText('settings-check-connection'));
    await screen.findByText("Daak can't reach any devices");
    fireEvent.press(screen.getByLabelText('cant-reach-settings'));
    expect(await screen.findByLabelText('save-name')).toBeTruthy();
    expect(screen.queryByText("Daak can't reach any devices")).toBeNull();
  });

  // The prototype's title is "Looking on Home-5G" and its body repeats it.
  // Nothing in this codebase knows the name of the network this device is on:
  // there is no API for it on iOS and no permission for it on Android. Naming
  // one would name a network Daak has never asked about.
  it('names no network anywhere on the screen', async () => {
    jest.spyOn(engine, 'devices').mockResolvedValue([]);
    render(<App />);
    fireEvent.press(await screen.findByText('Settings'));
    fireEvent.press(await screen.findByLabelText('settings-check-connection'));
    await screen.findByText("Daak can't reach any devices");
    expect(screen.queryByText(/Looking on/)).toBeNull();
    expect(screen.queryByText(/Home-5G/)).toBeNull();
  });
});
