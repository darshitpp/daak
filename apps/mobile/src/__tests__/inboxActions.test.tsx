import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { InboxEntry } from '@daak/core';
import { mockPlatformHost } from '../testPlatformMock';

// The Inbox row's verbs are INJECTED, and that injection is invisible at
// runtime: a host that forgets to pass them renders a row with no buttons, which
// looks identical to a row whose buttons do nothing. HistoryScreen.test.tsx
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
import { revealInFileManager, presentShare } from '@daak/platform';

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

beforeEach(() => jest.clearAllMocks());

it('shows a received file and reaches the native reveal and share sheet', async () => {
  jest.spyOn(engine, 'listInbox').mockResolvedValue([ENTRY]);
  render(<App />);
  // The tab bar exists only once App's durable onboarding read has resolved and
  // the shell has replaced the onboarding flow, so the press that navigates
  // cannot be synchronous any more.
  fireEvent.press(await screen.findByText('Inbox'));
  expect(await screen.findByText('report.pdf')).toBeTruthy();

  fireEvent.press(screen.getByLabelText('open-' + ENTRY.payloadId));
  await waitFor(() => expect(revealInFileManager).toHaveBeenCalledWith('/Users/d/Documents/report.pdf'));
  fireEvent.press(screen.getByLabelText('share-' + ENTRY.payloadId));
  expect(presentShare).toHaveBeenCalledWith({ urls: ['/Users/d/Documents/report.pdf'] });
});

// iOS reveal resolves false by design (R41). A silent no-op is the failure a
// user reports, so the row has to say so.
it('warns when this device cannot reveal a file', async () => {
  jest.spyOn(engine, 'listInbox').mockResolvedValue([ENTRY]);
  (revealInFileManager as jest.Mock).mockResolvedValueOnce(false);
  render(<App />);
  // The tab bar exists only once App's durable onboarding read has resolved and
  // the shell has replaced the onboarding flow, so the press that navigates
  // cannot be synchronous any more.
  fireEvent.press(await screen.findByText('Inbox'));
  fireEvent.press(await screen.findByLabelText('open-' + ENTRY.payloadId));
  expect(await screen.findByLabelText('inbox-no-reveal')).toBeTruthy();
});
