import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { DeviceCard } from './DeviceCard';

const device = { deviceId: 'aa'.repeat(16), name: 'Pixel 9', addr: '192.168.1.9:40001', online: true };

describe('DeviceCard', () => {
  it('renders the device and invokes onSend', () => {
    const onSend = jest.fn();
    render(<DeviceCard device={device} onSend={onSend} />);
    expect(screen.getByText('Pixel 9')).toBeTruthy();
    fireEvent.press(screen.getByText('Send'));
    expect(onSend).toHaveBeenCalledWith(device);
  });

  // M1: a Pressable that calls an empty function is a dead button in the
  // shipped UI. No callback, no button.
  it('renders no Send button when no callback is supplied', () => {
    render(<DeviceCard device={device} />);
    expect(screen.getByText('Pixel 9')).toBeTruthy();
    expect(screen.queryByText('Send')).toBeNull();
  });
});
