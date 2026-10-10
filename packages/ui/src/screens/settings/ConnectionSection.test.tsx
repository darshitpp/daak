import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ConnectionSection } from './ConnectionSection';

it('shows Working and Connected', () => {
  render(<ConnectionSection connection={{ status: 'working', wifi: 'connected' }} />);
  expect(screen.getByText('Working')).toBeTruthy();
  expect(screen.getByText('Connected')).toBeTruthy();
  expect(screen.getByText('This Wi-Fi')).toBeTruthy();
});

// Design v2: the macOS card labels the row "Network".
it('takes the network label from the host', () => {
  render(<ConnectionSection connection={{ status: 'working', wifi: 'connected' }} networkLabel="Network" />);
  expect(screen.getByText('Network')).toBeTruthy();
  expect(screen.queryByText('This Wi-Fi')).toBeNull();
});

it('shows Not working and Not connected', () => {
  render(<ConnectionSection connection={{ status: 'not-working', wifi: 'not-connected' }} />);
  expect(screen.getByText('Not working')).toBeTruthy();
  expect(screen.getByText('Not connected')).toBeTruthy();
});

// Ruling D6: the screen never prints a network name.
it('shows Checking while the facts are unknown', () => {
  render(<ConnectionSection connection={{ status: 'unknown', wifi: 'unknown' }} />);
  expect(screen.getAllByText('Checking')).toHaveLength(2);
});

it('offers the check link only when the host gives it', () => {
  const onCheckConnection = jest.fn();
  const { unmount } = render(<ConnectionSection connection={{ status: 'working', wifi: 'connected' }} onCheckConnection={onCheckConnection} />);
  fireEvent.press(screen.getByLabelText('settings-check-connection'));
  expect(onCheckConnection).toHaveBeenCalled();
  unmount();
  render(<ConnectionSection connection={{ status: 'working', wifi: 'connected' }} />);
  expect(screen.queryByLabelText('settings-check-connection')).toBeNull();
});

