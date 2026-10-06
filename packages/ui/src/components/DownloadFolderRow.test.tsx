import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { DownloadFolderRow } from './DownloadFolderRow';

// R42p: the row shows where received files go, and a CANCELLED picker must not
// change what it says. `null` is an answer -- the user closed the panel -- not
// an error, and treating it as one would clear a folder the user still has.
it('shows the stored folder and keeps it when the picker is cancelled', async () => {
  const load = async () => 'Downloads';
  const choose = async () => null;
  render(<DownloadFolderRow load={load} choose={choose} />);
  expect(await screen.findByText('Downloads')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('download-folder-choose'));
  await waitFor(() => expect(screen.getByText('Downloads')).toBeTruthy());
});

// No folder remembered is the DEFAULT, not an error, and the row says what the
// engine actually does: it keeps files in the app's own storage.
it('says the app keeps its own copy when no folder is chosen', async () => {
  render(<DownloadFolderRow load={async () => null} choose={async () => null} />);
  expect(await screen.findByText('This app\u2019s own storage')).toBeTruthy();
  expect(screen.queryByLabelText('download-folder-reset')).toBeNull();
});

// A chosen folder is shown, and Reset puts the row back to the default. Reset
// only exists once there is something to reset.
it('adopts a chosen folder and can reset it', async () => {
  const reset = async () => {};
  render(<DownloadFolderRow load={async () => null} choose={async () => 'Photos'} reset={reset} />);
  expect(await screen.findByText('This app\u2019s own storage')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('download-folder-choose'));
  expect(await screen.findByText('Photos')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('download-folder-reset'));
  expect(await screen.findByText('This app\u2019s own storage')).toBeTruthy();
});
