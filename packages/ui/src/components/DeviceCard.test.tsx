import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { DeviceInfo } from '@daak/core';
import { DeviceCard } from './DeviceCard';
import { colors } from '../theme';

const device: DeviceInfo = {
  deviceId: 'aa'.repeat(16),
  name: 'Pixel 9',
  addr: '192.168.1.9:40001',
  online: true,
  presence: 'online',
  paired: true,
};

describe('DeviceCard', () => {
  it('opens the conversation when a paired row is pressed', () => {
    const onOpen = jest.fn();
    render(<DeviceCard device={device} onOpen={onOpen} />);
    fireEvent.press(screen.getByTestId('open-' + device.deviceId));
    expect(onOpen).toHaveBeenCalledWith(device);
  });

  // The design moved Send and Unpair away from the row.
  it('has no Send button and no Unpair button', () => {
    render(<DeviceCard device={device} onOpen={jest.fn()} />);
    expect(screen.queryByText('Send')).toBeNull();
    expect(screen.queryByText('Unpair')).toBeNull();
  });

  it.each([
    ['online', 'On this network'],
    ['away', 'Away'],
    ['offline', 'Not on this network'],
  ] as const)('says the %s word', (presence, word) => {
    render(<DeviceCard device={{ ...device, presence, online: presence !== 'offline' }} onOpen={jest.fn()} />);
    expect(screen.getByText(word)).toBeTruthy();
  });

  // The engine queues a send to an offline peer, so the row stays selectable.
  it('keeps an offline paired device selectable', () => {
    const onOpen = jest.fn();
    render(<DeviceCard device={{ ...device, presence: 'offline', online: false }} onOpen={onOpen} />);
    fireEvent.press(screen.getByTestId('open-' + device.deviceId));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('shows the waiting badge only above zero', () => {
    const { rerender } = render(<DeviceCard device={device} onOpen={jest.fn()} queued={0} />);
    expect(screen.queryByText(/waiting/)).toBeNull();
    rerender(<DeviceCard device={device} onOpen={jest.fn()} queued={2} />);
    expect(screen.getByText('2 waiting')).toBeTruthy();
  });

  it('offers Pair and no row press for an unpaired peer', () => {
    const onOpen = jest.fn();
    const onPair = jest.fn();
    render(<DeviceCard device={{ ...device, paired: false }} onOpen={onOpen} onPair={onPair} />);
    expect(screen.queryByTestId('open-' + device.deviceId)).toBeNull();
    fireEvent.press(screen.getByText('Pair'));
    expect(onPair).toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  // HEAD 824b3d7: a new pairing stays pending until the user confirms the SAS.
  // The engine reports a pending peer with paired false (Engine::is_trusted) and
  // no presence. The row must not look paired or sendable.
  it('does not open or show a presence word for a pending pairing', () => {
    const onOpen = jest.fn();
    const pending: DeviceInfo = { ...device, paired: false, presence: undefined, online: true };
    render(<DeviceCard device={pending} onOpen={onOpen} />);
    expect(screen.queryByTestId('open-' + device.deviceId)).toBeNull();
    expect(screen.getByText('Nearby, not paired yet')).toBeTruthy();
    expect(screen.queryByText('On this network')).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
  });

  // Design index.html:660. A nearby, unpaired device shows an ok dot and the
  // words "Nearby, not paired yet".
  it('shows the design word and the ok dot for an unpaired device', () => {
    render(<DeviceCard device={{ ...device, paired: false }} onPair={jest.fn()} />);
    expect(screen.getByText('Nearby, not paired yet')).toBeTruthy();
    const dot = screen.getByTestId('status-dot-' + device.deviceId);
    expect(StyleSheet.flatten(dot.props.style).backgroundColor).toBe(colors.ok);
  });

  // An engine that predates the flag sends no `paired`. The safe reading is "not paired".
  it('treats a missing paired flag as unpaired', () => {
    render(<DeviceCard device={{ ...device, paired: undefined }} onOpen={jest.fn()} onPair={jest.fn()} />);
    expect(screen.queryByTestId('open-' + device.deviceId)).toBeNull();
    expect(screen.getByText('Pair')).toBeTruthy();
  });

  it('names a device with an empty name by its id prefix', () => {
    render(<DeviceCard device={{ ...device, name: '' }} onOpen={jest.fn()} />);
    expect(screen.getByText('Device aaaaaaaa')).toBeTruthy();
  });

  // Plan P4 rewrites the menu-bar panel. Until then it keeps its own label.
  it('accepts an explicit accessibility label for the row', () => {
    render(<DeviceCard device={device} onOpen={jest.fn()} openLabel={'send-to-' + device.deviceId} />);
    expect(screen.getByLabelText('send-to-' + device.deviceId)).toBeTruthy();
  });
});

