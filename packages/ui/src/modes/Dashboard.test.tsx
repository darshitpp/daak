import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { DaakEngine, DeviceInfo, SendRequest } from '@daak/core';
import { Dashboard } from './Dashboard';
import { fakeEngine } from '../testing/fakeEngine';
import { initialUiState } from '../state/store';

const peer: DeviceInfo = { deviceId: 'aa'.repeat(16), name: 'Pixel 9', addr: '', online: true, presence: 'online', paired: true };
const second: DeviceInfo = { deviceId: 'bb'.repeat(16), name: 'ThinkPad', addr: '', online: true, presence: 'online', paired: true };

// fakeEngine's send is a stub. The peerDeviceId in the request is the only
// proof of WHICH machine a rendered thread points at.
function spyEngine(devices: DeviceInfo[] = [peer]): { engine: DaakEngine; sent: SendRequest[] } {
  const sent: SendRequest[] = [];
  const engine = fakeEngine(devices);
  return {
    engine: {
      ...engine,
      send: async (req: SendRequest) => {
        sent.push(req);
        return { transferId: 'aa'.repeat(16), queued: false };
      },
    },
    sent,
  };
}

describe('Dashboard (window mode)', () => {
  it('opens on Devices with the window sidebar and its version footer', async () => {
    render(<Dashboard state={initialUiState} engine={fakeEngine([])} windowChrome={{ title: 'Daak for Mac', version: 'Version 1.0 (build 7)' }} />);
    expect(await screen.findByText('No paired devices yet')).toBeTruthy();
    expect(screen.getByTestId('window-sidebar')).toBeTruthy();
    expect(screen.getByText('Version 1.0 (build 7)')).toBeTruthy();
  });

  // The daak://send?deviceId=... link. Following it must point the thread at
  // the named device and at no other.
  it('opens the thread at the peerDeviceId override, not at the first device', async () => {
    const { engine, sent } = spyEngine([peer, second]);
    render(<Dashboard state={initialUiState} engine={engine} peerDeviceId={second.deviceId} />);
    fireEvent.changeText(await screen.findByPlaceholderText('Or type a note'), 'hi');
    fireEvent.press(screen.getByLabelText('send'));
    await waitFor(() => expect(sent).toEqual([{ peerDeviceId: second.deviceId, text: 'hi' }]));
  });

  // An override that names an unknown device must render no target. A fallback
  // to the first device would send to a machine the link never named.
  it('opens no composer when the override is not a known device', async () => {
    const { engine, sent } = spyEngine();
    render(<Dashboard state={initialUiState} engine={engine} peerDeviceId={'cc'.repeat(16)} />);
    expect(await screen.findByText('Not paired any more')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Or type a note')).toBeNull();
    expect(sent).toEqual([]);
  });

  // A prop threaded to nothing renders a button that looks live and is not.
  it('hands a host-supplied picker to the thread', async () => {
    const { engine, sent } = spyEngine();
    const onPickFiles = jest.fn(async () => ['/Users/d/Documents/a.pdf']);
    render(<Dashboard state={initialUiState} engine={engine} peerDeviceId={peer.deviceId} onPickFiles={onPickFiles} />);
    fireEvent.press(await screen.findByLabelText('pick-files'));
    await waitFor(() => expect(screen.getByText('a.pdf')).toBeTruthy());
    fireEvent.press(screen.getByLabelText('send'));
    await waitFor(() => expect(sent).toEqual([{ peerDeviceId: peer.deviceId, files: ['/Users/d/Documents/a.pdf'] }]));
  });
});

