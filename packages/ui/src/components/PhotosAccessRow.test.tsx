import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { PhotosAccessRow, type PhotosHost } from './PhotosAccessRow';

function host(overrides: Partial<PhotosHost> = {}): PhotosHost {
  return {
    destination: 'Photos',
    status: async () => 'undetermined',
    request: async () => true,
    openSettings: () => {},
    ...overrides,
  };
}

it('shows nothing when access is unavailable', async () => {
  render(<PhotosAccessRow photos={host({ status: async () => 'unavailable' })} />);
  await waitFor(() => expect(screen.queryByTestId('photos-access-row')).toBeNull());
});

it('shows nothing when access is granted', async () => {
  render(<PhotosAccessRow photos={host({ status: async () => 'granted' })} />);
  await waitFor(() => expect(screen.queryByTestId('photos-access-row')).toBeNull());
});

it('asks when access is undetermined', async () => {
  const request = jest.fn(async () => true);
  render(<PhotosAccessRow photos={host({ status: async () => 'undetermined', request })} />);
  expect(await screen.findByText('Save to Photos')).toBeTruthy();
  expect(screen.getByText('Allow Daak to add photos and videos to Photos.')).toBeTruthy();
  fireEvent.press(await screen.findByTestId('photos-access-allow'));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
});

it('opens system settings when access is denied', async () => {
  const openSettings = jest.fn();
  render(<PhotosAccessRow photos={host({ status: async () => 'denied', openSettings })} />);
  expect(await screen.findByText('Photos access is off')).toBeTruthy();
  expect(screen.getByText('Photos and videos stay in the save folder until you allow access.')).toBeTruthy();
  fireEvent.press(screen.getByTestId('photos-access-settings'));
  expect(openSettings).toHaveBeenCalledTimes(1);
});
