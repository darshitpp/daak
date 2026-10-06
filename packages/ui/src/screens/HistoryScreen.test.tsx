import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { InboxEntry } from '@daak/core';
import { EngineProvider } from '../EngineContext';
import { fakeEngine } from '../testing/fakeEngine';
import { HistoryScreen } from './HistoryScreen';
import type { InboxActions } from './HistoryScreen';

const file: InboxEntry = {
  payloadId: 'aa'.repeat(16), transferId: 'bb'.repeat(16), peerDeviceId: 'cc'.repeat(16),
  kind: 'media', itemCount: 2, summary: 'wifi-setup.pdf', receivedAt: 5,
  savedPaths: ['/data/inbox/wifi-setup.pdf'],
};
const text: InboxEntry = { ...file, payloadId: 'dd'.repeat(16), kind: 'text', summary: 'hello', savedPaths: [] };
const corrupt: InboxEntry = { ...file, payloadId: 'ee'.repeat(16), savedPaths: null };

function setup(entries: InboxEntry[], actions?: InboxActions) {
  const engine = fakeEngine();
  jest.spyOn(engine, 'listInbox').mockResolvedValue(entries);
  render(<EngineProvider engine={engine}><HistoryScreen actions={actions} /></EngineProvider>);
  return engine;
}

// The prototype's Inbox row is a button, and its sheet has two working verbs.
// Both are injected, so a host that supplies them must reach them, and the row
// must hand the engine's OWN savedPaths -- not the summary -- to the caller.
it('hands the first saved path to Show and every saved path to Share', async () => {
  const open = jest.fn(async () => true);
  const share = jest.fn();
  setup([file], { open, share });
  await waitFor(() => expect(screen.getByText('wifi-setup.pdf')).toBeTruthy());
  fireEvent.press(screen.getByLabelText('open-' + file.payloadId));
  fireEvent.press(screen.getByLabelText('share-' + file.payloadId));
  expect(open).toHaveBeenCalledWith('/data/inbox/wifi-setup.pdf');
  expect(share).toHaveBeenCalledWith(['/data/inbox/wifi-setup.pdf']);
});

// revealInFileManager resolves false on iOS by design. A Show button that
// reports nothing would be the failure the user reports, so the screen says so.
it('says so when the OS cannot reveal the file', async () => {
  setup([file], { open: async () => false, share: jest.fn() });
  await waitFor(() => expect(screen.getByText('wifi-setup.pdf')).toBeTruthy());
  fireEvent.press(screen.getByLabelText('open-' + file.payloadId));
  await act(async () => {});
  expect(screen.getByLabelText('inbox-no-reveal')).toBeTruthy();
});

// [] is a real answer ("this payload saved no files") and null is "unparseable".
// Neither has a file to show, so neither may render a verb that opens nothing.
it('renders no verb for an entry that saved nothing', async () => {
  setup([text, corrupt], { open: jest.fn(async () => true), share: jest.fn() });
  await waitFor(() => expect(screen.getByText('hello')).toBeTruthy());
  expect(screen.queryByLabelText('open-' + text.payloadId)).toBeNull();
  expect(screen.queryByLabelText('share-' + corrupt.payloadId)).toBeNull();
});

// A host that injects nothing gets the same inert rows it had before: a
// visible button wired to nothing is worse than no button.
it('renders no verb when the host injects none', async () => {
  setup([file]);
  await waitFor(() => expect(screen.getByText('wifi-setup.pdf')).toBeTruthy());
  expect(screen.queryByLabelText('open-' + file.payloadId)).toBeNull();
  expect(screen.queryByLabelText('share-' + file.payloadId)).toBeNull();
});

// A rejected listInbox reads as an empty Inbox otherwise, which sends the user
// looking for a missing file rather than at the log.
it('says so when the inbox cannot be read', async () => {
  const engine = fakeEngine();
  jest.spyOn(engine, 'listInbox').mockRejectedValue(new Error('database is locked'));
  render(<EngineProvider engine={engine}><HistoryScreen /></EngineProvider>);
  expect(await screen.findByText('database is locked')).toBeTruthy();
});

// R42l: `receivedAt` is SECONDS, the unit SQLite holds. The row read it as
// milliseconds, so every arrival was stamped 1970. A value a second ago must
// render the CURRENT year, which is the cheapest assertion that fails on the
// old code and cannot be satisfied by any fixed clock skew.
it('renders the arrival time from seconds, not milliseconds', async () => {
  const now = Math.floor(Date.now() / 1000);
  setup([{ ...text, receivedAt: now }]);
  await waitFor(() => expect(screen.getByText('hello')).toBeTruthy());
  // The row's sub-line is one interpolated string, so the assertion is on the
  // rendered text: the CURRENT year is present and 1970 is nowhere.
  expect(screen.getByText(new RegExp(String(new Date().getFullYear())))).toBeTruthy();
  expect(screen.queryByText(/1970/)).toBeNull();
});

// R42i: Copy is a host verb, so it renders only for a text entry AND only when
// the host supplied it. A file row has nothing to put on the clipboard.
it('offers Copy for a text entry when the host supplies the verb', async () => {
  const copy = jest.fn();
  setup([text, file], { copy });
  await waitFor(() => expect(screen.getByText('hello')).toBeTruthy());
  fireEvent.press(screen.getByLabelText('copy-' + text.payloadId));
  expect(copy).toHaveBeenCalledWith('hello');
  expect(screen.queryByLabelText('copy-' + file.payloadId)).toBeNull();
});
