import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { InboxEntry } from '@daak/core';
import { mockPlatformHost } from '../testPlatformMock';

// The Inbox row's verbs are INJECTED, and that injection is invisible at
// runtime: a host that forgets to pass them renders a row with no buttons, which
// looks identical to a row whose buttons do nothing. ThreadScreen.test.tsx
// proves the UI honours what it is given; this proves the app GIVES it the
// native calls.
jest.mock('@daak/platform', () => mockPlatformHost());

jest.mock('../bootstrap', () => ({
  engine: jest.requireActual('@daak/ui').fakeEngine(),
  startEngine: async () => {},
  startEngineOnce: jest.fn(async () => {}),
  drainInbound: jest.fn(async () => {}),
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

jest.mock('../BackgroundSyncNotice', () => ({ BackgroundSyncNotice: () => null }));
jest.mock('../PairingFlow', () => ({ PairingFlow: () => null }));

import App from '../App';
import { openFile, presentShare, copyToClipboard, fileSizes } from '@daak/platform';
import { threadItem, threadPage } from '@daak/ui';

const { engine } = jest.requireMock('../bootstrap');

const ENTRY: InboxEntry = {
  payloadId: 'aa'.repeat(16),
  transferId: 'bb'.repeat(16),
  peerDeviceId: 'cc'.repeat(16),
  kind: 'media',
  itemCount: 1,
  summary: 'report.pdf',
  receivedAt: 5,
  savedPaths: ['/Users/d/Documents/report.pdf'],
};

const DEVICE = { deviceId: ENTRY.peerDeviceId, name: 'Pixel 9', addr: '', online: true, presence: 'online' as const, paired: true };
const FILE = threadItem({
  transferId: ENTRY.transferId, type: 'file', text: null, name: 'report.pdf',
  destPath: '/Users/d/Documents/report.pdf',
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(engine, 'devices').mockResolvedValue([DEVICE]);
});
afterEach(() => jest.restoreAllMocks());

it('shows a received file in its thread and reaches the native open, share, and copy', async () => {
  jest.spyOn(engine, 'listThread').mockResolvedValue(
    threadPage([threadItem({ text: 'a note', transferId: 'dd'.repeat(16) }), FILE]),
  );
  render(<App />);
  fireEvent.press(await screen.findByTestId('open-' + DEVICE.deviceId));
  expect(await screen.findByText('report.pdf')).toBeTruthy();

  fireEvent.press(screen.getByLabelText('Preview report.pdf'));
  await waitFor(() => expect(openFile).toHaveBeenCalledWith('/Users/d/Documents/report.pdf'));
  fireEvent.press(screen.getByLabelText('Share report.pdf'));
  expect(presentShare).toHaveBeenCalledWith({ urls: ['/Users/d/Documents/report.pdf'] });
  fireEvent.press(screen.getByLabelText('Copy text'));
  expect(copyToClipboard).toHaveBeenCalledWith('a note');
  // The shared toast is mounted in App.tsx, so the design toast "Copied" shows.
  expect(await screen.findByText('Copied')).toBeTruthy();
});

// iOS reveal resolves false by design (R41). A silent no-op is the failure a
// user reports, so the thread has to say so.
it('warns when this device cannot open a file', async () => {
  jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage([FILE]));
  (openFile as jest.Mock).mockResolvedValueOnce(false);
  render(<App />);
  fireEvent.press(await screen.findByTestId('open-' + DEVICE.deviceId));
  fireEvent.press(await screen.findByLabelText('Preview report.pdf'));
  // Ruling: the warning is the design toast, not a note.
  expect(await screen.findByText('This device cannot open files.')).toBeTruthy();
});

it('hands the native fileSizes to the thread screen as an action', async () => {
  (fileSizes as jest.Mock).mockResolvedValueOnce([1024, null]);
  const { mobileInboxActions } = jest.requireActual('../inbox-actions');
  await expect(mobileInboxActions.fileSizes?.(['/a', '/b'])).resolves.toEqual([1024, null]);
  expect(fileSizes).toHaveBeenCalledWith(['/a', '/b']);
});
