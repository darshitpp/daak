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
const OTHER = 'cc'.repeat(16);
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
  jest.spyOn(engine, 'devices').mockResolvedValue([
    { deviceId: PEER, name: 'Pixel 9', addr: '192.168.1.9:40001', online: true, presence: 'online' as const, paired: true },
    { deviceId: OTHER, name: 'ThinkPad', addr: '', online: true, presence: 'online' as const, paired: true },
  ]);
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

it('routes a send link to the thread, prefilled and pointed at that peer', async () => {
  await openThenLink('daak://send?deviceId=' + PEER + '&text=from%20a%20link');
  expect(await screen.findByDisplayValue('from a link')).toBeTruthy();
  const sent = jest.spyOn(engine, 'send').mockResolvedValue({ transferId: 'bb'.repeat(16), queued: false });
  fireEvent.press(await screen.findByTestId('send'));
  await waitFor(() => expect(sent).toHaveBeenCalledWith({ peerDeviceId: PEER, text: 'from a link' }));
});

// A link is a request from another app or a web page. It prefills the note and
// opens the thread. It never sends: only the user's tap on Send sends.
it('does not send when a send link opens the thread', async () => {
  const sent = jest.spyOn(engine, 'send').mockResolvedValue({ transferId: 'bb'.repeat(16), queued: false });
  await openThenLink('daak://send?deviceId=' + PEER + '&text=from%20a%20link');
  expect(await screen.findByDisplayValue('from a link')).toBeTruthy();
  expect(sent).not.toHaveBeenCalled();
});

// Routing is the half no parser test could see: a link that arrives while the
// user sits on Devices must move them into the thread.
it('moves the user from Devices into the thread', async () => {
  render(<App />);
  fireEvent.press(await screen.findByTestId('tab-devices'));
  expect(screen.getByTestId('pair-a-device')).toBeTruthy();
  await act(async () => {
    emit('daak://send?deviceId=' + PEER);
  });
  expect(await screen.findByPlaceholderText('Or type a note')).toBeTruthy();
});

it('opens pairing from a pair link and joins with its bundle, no camera', async () => {
  const pair = jest.spyOn(engine, 'pair').mockResolvedValue({ sas: '555666' });
  render(<App />);
  emit('daak://pair?bundle=' + encodeURIComponent(BUNDLE));
  // Route reached, and the bundle handed to the engine as PARSED cbor -- never
  // the raw link value, which is the R88 rule for a scanned QR too.
  // The link's bundle names no address, so the fourth argument is `undefined`
  // and the joiner falls back to discovery (R42c/R42d).
  // A link is an untrusted request from another app or a web page. It asks the
  // user first and joins nothing until the user taps Pair.
  fireEvent.press(await screen.findByTestId('link-pair-confirm'));
  await waitFor(() => expect(pair).toHaveBeenCalledWith(PEER, 'qr', 'aabbcc', undefined));
  expect(await screen.findByText('555 666')).toBeTruthy();
  expect(jest.requireMock('@daak/platform').scanQr).not.toHaveBeenCalled();
});

it('asks before it joins a pair link, and Cancel joins nothing', async () => {
  const pair = jest.spyOn(engine, 'pair').mockResolvedValue({ sas: '555666' });
  render(<App />);
  emit('daak://pair?bundle=' + encodeURIComponent(BUNDLE));
  expect(await screen.findByText(/Pair with/)).toBeTruthy();
  expect(pair).not.toHaveBeenCalled();
  fireEvent.press(screen.getByTestId('link-pair-cancel'));
  expect(pair).not.toHaveBeenCalled();
  expect(screen.queryByTestId('link-pair-confirm')).toBeNull();
});

it('says so when a pair link is not a bundle', async () => {
  jest.spyOn(engine, 'pair').mockResolvedValue({ sas: 'x' });
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  render(<App />);
  emit('daak://pair?bundle=' + encodeURIComponent('not json'));
  // The screen shows the design note and the reason in its own small line. The log has it too.
  expect(await screen.findByText("We couldn't read that code.")).toBeTruthy();
  expect(screen.getByTestId('pairing-error-detail')).toHaveTextContent(/bad JSON/);
  expect(warn.mock.calls.flat().join(' ')).toContain('bad JSON');
  warn.mockRestore();
});

// The bug a naive mount effect would have shipped: PairingFlow is mounted
// whenever the pair route opens, so joining on mount re-pairs a user who came
// there from Devices and sees no link.
it('does not join when the pair route is opened by hand', async () => {
  const pair = jest.spyOn(engine, 'pair').mockResolvedValue({ sas: 'x' });
  render(<App />);
  fireEvent.press(await screen.findByTestId('tab-devices'));
  fireEvent.press(screen.getByTestId('pair-a-device'));
  expect(screen.getByText('Show my code')).toBeTruthy();
  expect(pair).not.toHaveBeenCalled();
});

// A hand-typed note must survive a re-render on a plain mount.
it('does not fight a hand-typed note once the thread is open', async () => {
  render(<App />);
  await act(async () => {
    emit('daak://send?deviceId=' + PEER);
  });
  fireEvent.changeText(await screen.findByPlaceholderText('Or type a note'), 'mine');
  expect(screen.getByDisplayValue('mine')).toBeTruthy();
});

// A send link with NO text must clear the box. The old note belongs to the
// previous target and must not go to a peer the user did not choose.
it('does not carry an earlier note to a later send link with no text', async () => {
  render(<App />);
  await act(async () => {
    emit('daak://send?deviceId=' + OTHER + '&text=for%20the%20old%20peer');
  });
  expect(await screen.findByDisplayValue('for the old peer')).toBeTruthy();
  await act(async () => {
    emit('daak://send?deviceId=' + PEER);
  });
  await waitFor(() => expect(screen.queryByDisplayValue('for the old peer')).toBeNull(), { timeout: 5000 });
});
