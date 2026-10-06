import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { DeviceCard } from './DeviceCard';

// `paired: true` because R42g hides Send on an unpaired peer: the engine refuses
// that send, so the card offers Pair instead.
const device = { deviceId: 'aa'.repeat(16), name: 'Pixel 9', addr: '192.168.1.9:40001', online: true, paired: true };

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

  // R42g: a peer seen only over mDNS has NO pairing, and the engine refuses a
  // send to it. The card must offer Pair, not Send, or the Send button fails.
  it('offers Pair and no Send for a discovered but unpaired peer', () => {
    const onSend = jest.fn();
    const onPair = jest.fn();
    render(<DeviceCard device={{ ...device, paired: false }} onSend={onSend} onPair={onPair} />);
    expect(screen.queryByText('Send')).toBeNull();
    expect(screen.getByText('Not paired')).toBeTruthy();
    fireEvent.press(screen.getByText('Pair'));
    expect(onPair).toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  // R42f: unpair is reachable from the device row, and only on a paired peer.
  it('offers Unpair on a paired peer', () => {
    const onUnpair = jest.fn();
    render(<DeviceCard device={device} onSend={jest.fn()} onUnpair={onUnpair} />);
    fireEvent.press(screen.getByText('Unpair'));
    expect(onUnpair).toHaveBeenCalledWith(device);
  });

  // An engine that predates the flag sends no `paired` at all. The safe reading
  // is "not paired": a Send that the engine refuses is worse than Pair.
  it('treats a missing paired flag as unpaired', () => {
    render(<DeviceCard device={{ ...device, paired: undefined }} onSend={jest.fn()} onPair={jest.fn()} />);
    expect(screen.queryByText('Send')).toBeNull();
    expect(screen.getByText('Pair')).toBeTruthy();
  });
});
