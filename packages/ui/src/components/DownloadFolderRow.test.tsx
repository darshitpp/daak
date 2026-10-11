import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { DownloadFolderRow } from './DownloadFolderRow';
import { ToastProvider } from './Toast';
import { colors } from '../theme';

// R42p: the row shows where received files go, and a CANCELLED picker must not
// change what it says. `null` is an answer -- the user closed the panel -- not
// an error, and treating it as one would clear a folder the user still has.
it('shows the stored folder and keeps it when the picker is cancelled', async () => {
  const load = async () => 'Downloads';
  const choose = async () => null;
  render(<DownloadFolderRow load={load} choose={choose} />);
  expect(await screen.findByText('Downloads')).toBeTruthy();
  fireEvent.press(screen.getByTestId('download-folder-choose'));
  await waitFor(() => expect(screen.getByText('Downloads')).toBeTruthy());
});

// No folder remembered is the DEFAULT, not an error, and the row says what the
// engine actually does: it keeps files in the app's own storage.
it('says the app keeps its own copy when no folder is chosen', async () => {
  render(<DownloadFolderRow load={async () => null} choose={async () => null} />);
  expect(await screen.findByText('This app\u2019s own storage')).toBeTruthy();
  expect(screen.queryByTestId('download-folder-reset')).toBeNull();
});

// A chosen folder is shown, and Reset puts the row back to the default. Reset
// only exists once there is something to reset.
it('adopts a chosen folder and can reset it', async () => {
  const reset = async () => {};
  render(<DownloadFolderRow load={async () => null} choose={async () => 'Photos'} reset={reset} />);
  expect(await screen.findByText('This app\u2019s own storage')).toBeTruthy();
  fireEvent.press(screen.getByTestId('download-folder-choose'));
  expect(await screen.findByText('Photos')).toBeTruthy();
  // The design button uses a plain ASCII apostrophe (index.html:701).
  expect(screen.getByText("Use the app's own storage")).toBeTruthy();
  // The design button is "btn-quiet", which is the default quiet variant.
  expect(StyleSheet.flatten(screen.getByTestId('download-folder-reset').props.style).borderColor).toBe(colors.border);
  fireEvent.press(screen.getByTestId('download-folder-reset'));
  expect(await screen.findByText('This app\u2019s own storage')).toBeTruthy();
});

it('takes a title and a button label from the caller', async () => {
  render(<DownloadFolderRow load={async () => null} choose={async () => null} title="Save files to" chooseLabel="Change folder" />);
  expect(await screen.findByText('Save files to')).toBeTruthy();
  expect(screen.getByText('Change folder')).toBeTruthy();
});

// Design `showToast('Files save to ' + savePath)` after the folder changes.
it('toasts where files save after a folder is chosen', async () => {
  render(
    <ToastProvider>
      <DownloadFolderRow load={async () => null} choose={async () => 'Photos'} title="Save files to" chooseLabel="Change folder" />
    </ToastProvider>,
  );
  fireEvent.press(await screen.findByTestId('download-folder-choose'));
  expect(await screen.findByText('Files save to Photos')).toBeTruthy();
});

it('shows no toast when the picker is cancelled', async () => {
  render(
    <ToastProvider>
      <DownloadFolderRow load={async () => 'Downloads'} choose={async () => null} />
    </ToastProvider>,
  );
  fireEvent.press(await screen.findByTestId('download-folder-choose'));
  await waitFor(() => expect(screen.getByTestId('download-folder-choose')).not.toBeDisabled());
  expect(screen.queryByTestId('toast')).toBeNull();
});

// Fallback for a host with no picker. The iPhone prototype words (design v2).
it('shows the no-picker words and no button when the host gives no choose', async () => {
  render(<DownloadFolderRow load={async () => null} title="Save files to" />);
  expect(await screen.findByText('Saved to')).toBeTruthy();
  expect(screen.getByText('Daak · On My iPhone')).toBeTruthy();
  expect(screen.getByText("iOS keeps received files in Daak's own folder. There's no folder to pick.")).toBeTruthy();
  expect(screen.queryByTestId('download-folder-choose')).toBeNull();
  expect(screen.queryByText('Files are moved, not copied')).toBeNull();
});

it('hides the note when asked', async () => {
  render(<DownloadFolderRow load={async () => null} choose={async () => null} hideNote />);
  await screen.findByTestId('download-folder-choose');
  expect(screen.queryByText('Files are moved, not copied')).toBeNull();
});

it('keeps the note by default', async () => {
  render(<DownloadFolderRow load={async () => null} choose={async () => null} />);
  expect(await screen.findByText('Files are moved, not copied')).toBeTruthy();
});

