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
});
