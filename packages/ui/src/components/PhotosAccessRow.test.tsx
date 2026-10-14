import React from 'react';
import { AppState } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { PhotosAccessRow, type PhotosHost } from './PhotosAccessRow';

function host(overrides: Partial<PhotosHost> = {}): PhotosHost {
  return {
    destination: 'Photos app',
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
  expect(await screen.findByText('Save to the Photos app')).toBeTruthy();
  expect(screen.getByText('Allow Daak to add photos and videos to the Photos app.')).toBeTruthy();
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

it('reads the status again after Allow and hides when it is granted', async () => {
  const status = jest.fn<ReturnType<PhotosHost['status']>, []>()
    .mockResolvedValueOnce('undetermined')
    .mockResolvedValue('granted');
  render(<PhotosAccessRow photos={host({ status })} />);
  fireEvent.press(await screen.findByTestId('photos-access-allow'));
  await waitFor(() => expect(screen.queryByTestId('photos-access-row')).toBeNull());
  expect(status).toHaveBeenCalledTimes(2);
});

it('reads the status again when the app becomes active', async () => {
  let onChange: (s: string) => void = () => {};
  const remove = jest.fn();
  const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation(((_: string, cb: (s: string) => void) => {
    onChange = cb;
    return { remove };
  }) as never);
  const status = jest.fn<ReturnType<PhotosHost['status']>, []>()
    .mockResolvedValueOnce('denied')
    .mockResolvedValue('granted');
  const { unmount } = render(<PhotosAccessRow photos={host({ status })} />);
  expect(await screen.findByTestId('photos-access-row')).toBeTruthy();
  act(() => onChange('active'));
  await waitFor(() => expect(screen.queryByTestId('photos-access-row')).toBeNull());
  unmount();
  expect(remove).toHaveBeenCalledTimes(1);
  spy.mockRestore();
});

it('keeps the old state when the status read fails on activation', async () => {
  let onChange: (s: string) => void = () => {};
  const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation(((_: string, cb: (s: string) => void) => {
    onChange = cb;
    return { remove: () => {} };
  }) as never);
  const status = jest.fn<ReturnType<PhotosHost['status']>, []>()
    .mockResolvedValueOnce('denied')
    .mockRejectedValue(new Error('boom'));
  render(<PhotosAccessRow photos={host({ status })} />);
  expect(await screen.findByTestId('photos-access-row')).toBeTruthy();
  act(() => onChange('active'));
  await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
  expect(screen.getByTestId('photos-access-row')).toBeTruthy();
  spy.mockRestore();
});

it('does not read the status again after unmount when Allow finishes late', async () => {
  let release: () => void = () => {};
  const request = jest.fn(() => new Promise<boolean>((r) => { release = () => r(true); }));
  const status = jest.fn(async () => 'undetermined' as const);
  const { unmount } = render(<PhotosAccessRow photos={host({ request, status })} />);
  fireEvent.press(await screen.findByTestId('photos-access-allow'));
  unmount();
  await act(async () => { release(); });
  expect(status).toHaveBeenCalledTimes(1);
});
