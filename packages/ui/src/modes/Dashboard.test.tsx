import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Dashboard } from './Dashboard';
import { fakeEngine } from '../testing/fakeEngine';
import { initialUiState } from '../state/store';
import type { DaakEngine, DeviceInfo, SendRequest, TransferSummary } from '@daak/core';

const peer: DeviceInfo = { deviceId: 'aa'.repeat(16), name: 'Pixel 9', addr: '192.168.1.9:40001', online: true };
const second: DeviceInfo = { deviceId: 'bb'.repeat(16), name: 'ThinkPad', addr: '192.168.1.10:40001', online: true };

// fakeEngine's send is a stub, so the ONLY way to tell which peer a rendered
// Send tab points at is to capture the request it hands the engine. Two devices
// both render an identical-looking screen; the peerDeviceId in the send is the
// whole difference, and it is the difference that decides which machine gets the
// file.
function spyEngine(devices: DeviceInfo[] = [peer]): { engine: DaakEngine; sent: SendRequest[] } {
  const sent: SendRequest[] = [];
  const engine = fakeEngine();
  return {
    engine: {
      ...engine,
      devices: async () => devices,
      send: async (req: SendRequest) => {
        sent.push(req);
        return { transferId: 'aa'.repeat(16), queued: true };
      },
    },
    sent,
  };
}

describe('Dashboard', () => {
  // Send is a TAB now, so a cold engine lands on an honest empty state rather
  // than a permanently-disabled composer above the device list. The note field
  // is still there -- text can be composed before a device appears -- but there
  // is no target, so the send button stays disabled.
  it('opens on Send with no devices and no way to send', async () => {
    render(<Dashboard state={initialUiState} engine={fakeEngine()} />);
    expect(await screen.findByText('No devices on this network')).toBeTruthy();
    expect(screen.getByLabelText('send')).toBeDisabled();
  });

  // R3: the cold-daemon case, and the one a real user hits every launch. No
  // engine populates online on the daemon path, and enqueue_outbox_send
  // queues durably regardless of liveness, so liveness is NOT a precondition
  // for sending. Gating on it hid the primary action permanently.
  it('renders Send for a device whose liveness is unknown', async () => {
    const { engine } = spyEngine([{ deviceId: peer.deviceId, name: peer.name, addr: peer.addr }]);
    render(<Dashboard state={initialUiState} engine={engine} />);
    expect(await screen.findByPlaceholderText('Message')).toBeTruthy();
  });

  it('renders Send for an explicitly online device', async () => {
    const { engine } = spyEngine();
    render(<Dashboard state={initialUiState} engine={engine} />);
    expect(await screen.findByPlaceholderText('Message')).toBeTruthy();
  });

  it('renders Send for a device last seen offline', async () => {
    const { engine } = spyEngine([{ ...peer, online: false }]);
    render(<Dashboard state={initialUiState} engine={engine} />);
    expect(await screen.findByPlaceholderText('Message')).toBeTruthy();
  });

  // The daak://send?deviceId=... deep link. The dashboard otherwise composes at
  // the first device, so following such a link into a device list whose FIRST
  // entry is somebody else would point the composer at the wrong peer -- which
  // is not a cosmetic bug, it sends the file to the wrong machine.
  it('composes at the peerDeviceId override, not at the first device', async () => {
    const { engine, sent } = spyEngine([peer, second]);
    render(<Dashboard state={initialUiState} engine={engine} peerDeviceId={second.deviceId} />);
    fireEvent.changeText(await screen.findByPlaceholderText('Message'), 'hi');
    fireEvent.press(screen.getByLabelText('send'));
    await waitFor(() => expect(sent).toEqual([{ peerDeviceId: second.deviceId, text: 'hi', files: [] }]));
  });

  // An override naming a device this build does not know MUST render no
  // target. Falling back to devices[0] would send the file to a peer the user
  // did not name, which is the same wrong-peer failure the override exists to
  // prevent -- just reached by a shorter route.
  it('composes at no target when the peerDeviceId override is not a known device', async () => {
    const { engine, sent } = spyEngine();
    render(<Dashboard state={initialUiState} engine={engine} peerDeviceId={'cc'.repeat(16)} />);
    fireEvent.changeText(await screen.findByPlaceholderText('Message'), 'hi');
    expect(screen.getByLabelText('send')).toBeDisabled();
    fireEvent.press(screen.getByLabelText('send'));
    expect(sent).toEqual([]);
  });

  // The picker is the DASHBOARD's prop, not the Send tab's own: Dashboard is the
  // macOS/desktop render site, and a host that supplies one must reach it. A prop
  // threaded to nothing renders exactly like the old fabricated path did -- a
  // button that looks live and is not.
  it('hands a host-supplied picker to the Send tab', async () => {
    const { engine, sent } = spyEngine();
    const onPickFiles = jest.fn(async () => ['/Users/d/Documents/a.pdf']);
    render(<Dashboard state={initialUiState} engine={engine} onPickFiles={onPickFiles} />);
    fireEvent.press(screen.getByLabelText('pick-files'));
    await waitFor(() => expect(screen.getByText('a.pdf')).toBeTruthy());
    fireEvent.press(screen.getByLabelText('send'));
    await waitFor(() =>
      expect(sent).toEqual([{ peerDeviceId: peer.deviceId, text: undefined, files: ['/Users/d/Documents/a.pdf'] }]),
    );
  });

  // Two sends at once used to leave the second invisible: the Dashboard picked
  // the FIRST active transfer and rendered only that one.
  it('lists every transfer, not just the first active one', async () => {
    const engine = fakeEngine();
    const base: Omit<TransferSummary, 'transferId'> = {
      peerDeviceId: peer.deviceId, direction: 'in', kind: 'media', state: 'active',
      bytesDone: 1, bytesTotal: 2, itemCount: 1, updatedAt: 5,
    };
    jest.spyOn(engine, 'devices').mockResolvedValue([peer, second]);
    jest.spyOn(engine, 'listTransfers').mockResolvedValue([
      { ...base, transferId: 'aa'.repeat(16) },
      { ...base, transferId: 'bb'.repeat(16), peerDeviceId: second.deviceId, updatedAt: 6 },
    ]);
    render(<Dashboard state={initialUiState} engine={engine} />);
    fireEvent.press(screen.getByText('Transfers'));
    await waitFor(() => expect(screen.getByText('1 item(s) from ThinkPad')).toBeTruthy());
    expect(screen.getByText('1 item(s) from Pixel 9')).toBeTruthy();
  });
});
