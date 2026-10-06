import React from 'react';
import { Linking } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { DaakEngine } from '@daak/core';
import { mockPlatformHost } from '../testPlatformMock';
import App from '../App';

// The deep link was a parser with no caller: parseDeepLink handled daak://send
// and daak://pair perfectly and NOTHING in the app ever subscribed to it. A
// link is the whole entry point for the QR the other device showed, so
// "parses correctly" was never the same as "does anything". deeplink.test.ts
// pins the parser; this pins the effect on screen.
const PEER = 'aa'.repeat(16);
const BUNDLE = JSON.stringify({ cbor: 'aabbcc', name: 'Pixel 9', device_id: PEER });

jest.mock('../bootstrap', () => ({
  engine: jest.requireActual('@daak/ui').fakeEngine(),
  startEngine: async () => {},
  startEngineOnce: jest.fn(async () => {}),
  drainInbound: jest.fn(async () => {}),
  wireNotificationActions: jest.fn(() => () => {}),
  sendIntentItems: jest.fn(async () => {}),
  onPairingSas: () => () => {},
  // The peer.incompatible fan-out off the ONE engine subscription. Every file
  // that renders App needs it: the import is undefined without it and the mount
  // effect throws before the shell renders at all.
  onIncompatiblePeer: jest.fn(() => () => {}),
  postReceiveNotifications: jest.fn(async () => true),
  notificationGrant: jest.fn(() => true),
  // OnboardingFlow records the OS's answer here so startup reuses it instead of
  // asking a second time. Absent, the import is undefined and the Permissions
  // step throws -- which is what took these two pair-link tests down.
  recordNotificationGrant: jest.fn(),
}));

// App reaches @daak/platform through SendFlow's picker, PairingFlow's QR and
// inbox-actions; the real barrel pulls cbor-x (ESM) in through @daak/core and
// jest cannot parse it. Only the four things PairingFlow touches are stubbed --
// the flow itself is the real one, because a stubbed flow would pass this file
// while proving nothing about a link.
jest.mock('@daak/platform', () =>
  mockPlatformHost({
    pairingBundle: jest.fn(async () => JSON.stringify({ cbor: 'aabb', name: 'me', device_id: 'bb'.repeat(16) })),
    generateQr: jest.fn(async () => 'data:image/png;base64,QUJD'),
    scanQr: jest.fn(async () =>
      JSON.stringify({ cbor: 'aabbcc', name: 'Pixel 9', device_id: 'aa'.repeat(16) }),
    ),
  }),
);

jest.mock('../BackgroundSyncNotice', () => ({ BackgroundSyncNotice: () => null }));

const { engine } = jest.requireMock('../bootstrap') as { engine: DaakEngine };

let emit: (url: string) => void;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(engine, 'devices').mockResolvedValue([{ deviceId: PEER, name: 'Pixel 9', addr: '192.168.1.9:40001' }]);
  // No cold-launch URL: every test here arrives through the event, which is the
  // half getInitialURL never reached anyway (it fired before the first render).
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(null);
  jest.spyOn(Linking, 'addEventListener').mockImplementation(((_t: string, cb: (e: { url: string }) => void) => {
    emit = (url) => cb({ url });
    return { remove: () => {} };
  }) as never);
});

afterEach(() => jest.restoreAllMocks());

async function openThenLink(url: string) {
  render(<App />);
  emit(url);
}

it('routes a send link to the composer, prefilled and pointed at that peer', async () => {
  await openThenLink('daak://send?deviceId=' + PEER + '&text=from%20a%20link');
  expect(await screen.findByDisplayValue('from a link')).toBeTruthy();
  const sent = jest.spyOn(engine, 'send').mockResolvedValue({ transferId: 'bb'.repeat(16), queued: true });
  fireEvent.press(screen.getByLabelText('send'));
  await waitFor(() =>
    expect(sent).toHaveBeenCalledWith({ peerDeviceId: PEER, text: 'from a link', files: [] }),
  );
});

// Routing is the half no existing test could see: the parser test proved the
// deviceId came out, this proves a link arriving while the user sits on
// Devices actually moves them to the composer.
it('pulls the Devices tab to Send', async () => {
  render(<App />);
    // The shell replaces the onboarding flow only once App's durable read has
    // resolved, so the tab that navigates cannot be pressed synchronously.
    fireEvent.press(await screen.findByText('Devices'));
  expect(screen.getByLabelText('pair-a-device')).toBeTruthy();
  emit('daak://send?deviceId=' + PEER);
  expect(await screen.findByPlaceholderText('Message')).toBeTruthy();
});

it('opens pairing from a pair link and joins with its bundle, no camera', async () => {
  const pair = jest.spyOn(engine, 'pair').mockResolvedValue({ sas: '555666' });
  render(<App />);
  emit('daak://pair?bundle=' + encodeURIComponent(BUNDLE));
  // Route reached, and the bundle handed to the engine as PARSED cbor -- never
  // the raw link value, which is the R88 rule for a scanned QR too.
  // The link's bundle names no address, so the fourth argument is `undefined`
  // and the joiner falls back to discovery (R42c/R42d).
  await waitFor(() => expect(pair).toHaveBeenCalledWith(PEER, 'qr', 'aabbcc', undefined));
  expect(await screen.findByText('555666')).toBeTruthy();
  expect(jest.requireMock('@daak/platform').scanQr).not.toHaveBeenCalled();
});

it('says so when a pair link is not a bundle', async () => {
  jest.spyOn(engine, 'pair').mockResolvedValue({ sas: 'x' });
  render(<App />);
  emit('daak://pair?bundle=' + encodeURIComponent('not json'));
  expect(await screen.findByText(/bad JSON/)).toBeTruthy();
});

// The bug a naive mount effect would have shipped: PairingFlow is mounted
// whenever the pair route opens, so joining on mount re-pairs a user who came
// there from Devices and sees no link.
it('does not join when the pair route is opened by hand', async () => {
  const pair = jest.spyOn(engine, 'pair').mockResolvedValue({ sas: 'x' });
  render(<App />);
  fireEvent.press(await screen.findByText('Devices'));
  fireEvent.press(screen.getByLabelText('pair-a-device'));
  expect(screen.getByText('Show QR')).toBeTruthy();
  expect(pair).not.toHaveBeenCalled();
});

// Same for the send route: App starts ON Send, and a seeding effect keyed on
// nothing would wipe the composer of anything typed there.
it('does not fight a hand-typed note on a plain mount', async () => {
  render(<App />);
  fireEvent.changeText(await screen.findByPlaceholderText('Message'), 'mine');
  expect(screen.getByDisplayValue('mine')).toBeTruthy();
});

// The leak: a send link that names NO text left initialText undefined, and
// SendScreen only seeded on a TRUTHY value, so the note typed for the previous
// target survived -- and went out attached to the files on a peer the user's
// own tap never chose. A textless link must CLEAR the box, not merge with it.
it('does not carry an earlier note to a later send link with no text', async () => {
  render(<App />);
  fireEvent.changeText(await screen.findByPlaceholderText('Message'), 'for the old peer');
  // React 19: an update driven from the Linking listener is outside act, so it
  // is not flushed by the time the assertions run. Wrap it, like the other
  // tests in this file already do.
  await act(async () => {
    emit('daak://send?deviceId=' + PEER);
  });
  expect(await screen.findByText('Send to Pixel 9')).toBeTruthy();
  // React 19 flushes the link's state update on a later tick, and this file
  // runs beside 30 others in the gate. 1s was not enough there.
  await waitFor(() => expect(screen.queryByDisplayValue('for the old peer')).toBeNull(), {
    timeout: 5000,
  });
});
