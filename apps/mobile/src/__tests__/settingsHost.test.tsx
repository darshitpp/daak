import React from 'react';
import { Linking } from 'react-native';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { mockPlatformHost } from '../testPlatformMock';

// The version is fake on purpose: a test that reads it proves the value came
// through the host, not from a constant in ui.
jest.mock('@daak/platform', () =>
  mockPlatformHost({ appInfo: jest.fn(async () => ({ version: '0.0.0-test', build: '1' })) }),
);

jest.mock('../bootstrap', () => ({
  engine: jest.requireActual('@daak/ui').fakeEngine(),
  startEngine: async () => {},
  startEngineOnce: jest.fn(async () => {}),
  drainInbound: jest.fn(async () => {}),
  wireNotificationActions: jest.fn(() => () => {}),
  sendIntentItems: jest.fn(async () => {}),
  onIncompatiblePeer: jest.fn(() => () => {}),
  postReceiveNotifications: jest.fn(async () => true),
  notificationGrant: jest.fn(() => true),
  recordNotificationGrant: jest.fn(),
}));
jest.mock('../BackgroundSyncNotice', () => ({ BackgroundSyncNotice: () => null }));
jest.mock('../PairingFlow', () => ({ PairingFlow: () => null }));

import App from '../App';
import { appInfo, readOnboarding, saveNotifyPrefs } from '@daak/platform';

const { engine } = jest.requireMock('../bootstrap');
const paired = { deviceId: 'aa'.repeat(16), name: 'Pixel 9', addr: '', online: true, presence: 'online', paired: true };

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(engine, 'devices').mockResolvedValue([paired]);
});
afterEach(() => jest.restoreAllMocks());

const openSettings = async () => {
  render(<App />);
  fireEvent.press(await screen.findByTestId('tab-settings'));
};

it('shows the version that the platform module reports', async () => {
  await openSettings();
  expect(await screen.findByText('Version 0.0.0-test (build 1)')).toBeTruthy();
  expect(appInfo).toHaveBeenCalled();
});

it('shows no version row when the platform module rejects', async () => {
  (appInfo as jest.Mock).mockRejectedValueOnce(new Error('no native module'));
  await openSettings();
  await screen.findByText('About Daak');
  await waitFor(() => expect(appInfo).toHaveBeenCalled());
  expect(screen.queryByText(/^Version /)).toBeNull();
});

it('saves the arrival switch through the platform preference store', async () => {
  await openSettings();
  fireEvent.press(await screen.findByLabelText('Tell me when a file arrives'));
  await waitFor(() => expect(saveNotifyPrefs).toHaveBeenCalledWith({ arrival: false }));
  expect(screen.queryByText('Play a sound too')).toBeNull();
});

it('says the phone in the arrival hint', async () => {
  await openSettings();
  expect(await screen.findByText('Shows a message on this phone.')).toBeTruthy();
});

// The Remove sheet revokes. The host must not revoke a second time.
it('revokes a pairing exactly once', async () => {
  const revoke = jest.spyOn(engine, 'revokePairing').mockResolvedValue(undefined);
  await openSettings();
  fireEvent.press(await screen.findByTestId('remove-' + paired.deviceId));
  fireEvent.press(screen.getByTestId('confirm-remove'));
  await waitFor(() => expect(revoke).toHaveBeenCalledTimes(1));
  await new Promise((r) => setTimeout(r, 50));
  expect(revoke).toHaveBeenCalledTimes(1);
});

// Keep this test last: it changes the stored OS answer for the rest of the file.
it('opens system settings when the stored OS answer is off', async () => {
  (readOnboarding as jest.Mock).mockResolvedValue({ complete: true, name: 'x', discovery: true, alerts: false });
  const open = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
  await openSettings();
  expect(
    await screen.findByText(
      "If notifications for Daak are blocked in your system settings, this switch can't turn alerts on. Allow notifications for Daak there, then try again.",
    ),
  ).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Tell me when a file arrives'));
  expect(open).toHaveBeenCalledTimes(1);
});

