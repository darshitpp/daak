import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { Dashboard } from './Dashboard';
import { fakeEngine } from '../testing/fakeEngine';
import { initialUiState } from '../state/store';

const peer = { deviceId: 'aa'.repeat(16), name: 'Pixel 9', addr: '192.168.1.9:40001', online: true };

describe('Dashboard', () => {
  // AppShell renders `composer` ABOVE the tab content unconditionally, so with
  // no device at all there was a permanently-disabled composer sitting above
  // Devices, History and Settings.
  it('renders no composer when the device list is empty', () => {
    render(<Dashboard state={initialUiState} engine={fakeEngine()} />);
    expect(screen.queryByPlaceholderText('Message')).toBeNull();
  });

  // R3: the cold-daemon case, and the one a real user hits every launch. No
  // engine populates `online` on the daemon path, and enqueue_outbox_send
  // queues durably regardless of liveness, so liveness is NOT a precondition
  // for sending. Gating on it hid the primary action permanently.
  it('renders the composer for a device whose liveness is unknown', () => {
    render(
      <Dashboard
        state={{ ...initialUiState, devices: [{ deviceId: peer.deviceId, name: peer.name, addr: peer.addr }] }}
        engine={fakeEngine()}
      />,
    );
    expect(screen.getByPlaceholderText('Message')).toBeTruthy();
  });

  it('renders the composer for an explicitly online device', () => {
    render(
      <Dashboard state={{ ...initialUiState, devices: [peer] }} engine={fakeEngine()} />,
    );
    expect(screen.getByPlaceholderText('Message')).toBeTruthy();
  });

  it('renders the composer for a device last seen offline', () => {
    render(
      <Dashboard
        state={{ ...initialUiState, devices: [{ ...peer, online: false }] }}
        engine={fakeEngine()}
      />,
    );
    expect(screen.getByPlaceholderText('Message')).toBeTruthy();
  });
});
