import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Dashboard } from './Dashboard';
import { fakeEngine } from '../testing/fakeEngine';
import { initialUiState } from '../state/store';
import type { DaakEngine, SendRequest } from '@daak/core';

const peer = { deviceId: 'aa'.repeat(16), name: 'Pixel 9', addr: '192.168.1.9:40001', online: true };
const second = { deviceId: 'bb'.repeat(16), name: 'ThinkPad', addr: '192.168.1.10:40001', online: true };

// fakeEngine's send is a stub, so the ONLY way to tell which peer a rendered
// composer points at is to capture the request it hands the engine. Two devices
// both render an identical-looking composer; the peerDeviceId in the send is the
// whole difference, and it is the difference that decides which machine gets the
// file.
function spyEngine(): { engine: DaakEngine; sent: SendRequest[] } {
  const sent: SendRequest[] = [];
  const engine = fakeEngine();
  return {
    engine: { ...engine, send: async (req: SendRequest) => { sent.push(req); return { transferId: 'aa'.repeat(16), queued: true }; } },
    sent,
  };
}

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

  // The daak://send?deviceId=... deep link. The dashboard otherwise composes at
  // state.devices[0], so following such a link into a device list whose FIRST
  // entry is somebody else would point the composer at the wrong peer -- which
  // is not a cosmetic bug, it sends the file to the wrong machine.
  it('composes at the peerDeviceId override, not at the first device', () => {
    const { engine, sent } = spyEngine();
    render(
      <Dashboard
        state={{ ...initialUiState, devices: [peer, second] }}
        engine={engine}
        peerDeviceId={second.deviceId}
      />,
    );
    expect(screen.getByPlaceholderText('Message')).toBeTruthy();
    fireEvent.changeText(screen.getByPlaceholderText('Message'), 'hi');
    fireEvent.press(screen.getByLabelText('send'));
    expect(sent).toEqual([{ peerDeviceId: second.deviceId, text: 'hi', files: [] }]);
  });

  // An override naming a device this build does not know MUST render no
  // composer. Falling back to devices[0] would send the file to a peer the user
  // did not name, which is the same wrong-peer failure the override exists to
  // prevent -- just reached by a shorter route.
  it('renders no composer when the peerDeviceId override is not a known device', () => {
    render(
      <Dashboard
        state={{ ...initialUiState, devices: [peer] }}
        engine={fakeEngine()}
        peerDeviceId={'cc'.repeat(16)}
      />,
    );
    expect(screen.queryByPlaceholderText('Message')).toBeNull();
  });
});
