import React from 'react';
import { fireEvent, renderAsync, screen, waitFor, fireEventAsync } from '@testing-library/react-native';
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
    await renderAsync(<Dashboard state={initialUiState} engine={fakeEngine([])} windowChrome={{ version: 'Version 1.0 (build 7)' }} />);
    expect(await screen.findByText('No paired devices yet')).toBeTruthy();
    expect(screen.getByTestId('window-sidebar')).toBeTruthy();
    expect(screen.getByText('Version 1.0 (build 7)')).toBeTruthy();
  });

  // The daak://send?deviceId=... link. Following it must point the thread at
  // the named device and at no other.
  it('opens the thread at the peerDeviceId override, not at the first device', async () => {
    const { engine, sent } = spyEngine([peer, second]);
    await renderAsync(<Dashboard state={initialUiState} engine={engine} peerDeviceId={second.deviceId} />);
    await fireEventAsync.changeText(await screen.findByPlaceholderText('Or type a note'), 'hi');
    await fireEventAsync.press(screen.getByTestId('send'));
    await waitFor(() => expect(sent).toEqual([{ peerDeviceId: second.deviceId, text: 'hi' }]));
  });

  // An override that names an unknown device must render no target. A fallback
  // to the first device would send to a machine the link never named.
  it('opens no composer when the override is not a known device', async () => {
    const { engine, sent } = spyEngine();
    await renderAsync(<Dashboard state={initialUiState} engine={engine} peerDeviceId={'cc'.repeat(16)} />);
    expect(await screen.findByText('Not paired any more')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Or type a note')).toBeNull();
    expect(sent).toEqual([]);
  });

  // A prop threaded to nothing renders a button that looks live and is not.
  it('hands a host-supplied picker to the thread', async () => {
    const { engine, sent } = spyEngine();
    const onPickFiles = jest.fn(async () => ['/Users/d/Documents/a.pdf']);
    await renderAsync(<Dashboard state={initialUiState} engine={engine} peerDeviceId={peer.deviceId} onPickFiles={onPickFiles} />);
    await fireEventAsync.press(await screen.findByTestId('pick-files'));
    await waitFor(() => expect(screen.getByText('a.pdf')).toBeTruthy());
    await fireEventAsync.press(screen.getByTestId('send'));
    await waitFor(() => expect(sent).toEqual([{ peerDeviceId: peer.deviceId, files: ['/Users/d/Documents/a.pdf'] }]));
  });

  it('media is passed through to the thread', async () => {
    const { engine } = spyEngine();
    const media = { pick: jest.fn(async () => []), materialize: jest.fn(async () => ''), fits: jest.fn(async () => true) };
    await renderAsync(
      <Dashboard state={initialUiState} engine={engine} peerDeviceId={peer.deviceId}
        onPickFiles={async () => []} onPickFolder={async () => null} media={media} />,
    );
    await fireEventAsync.press(await screen.findByTestId('pick-files'));
    await fireEventAsync.press(screen.getByTestId('pick-menu-photos'));
    await waitFor(() => expect(media.pick).toHaveBeenCalledTimes(1));
  });

  it('batch is passed through to the thread', async () => {
    const { engine } = spyEngine();
    const batch = {
      status: jest.fn(() => ({ share: 'cc'.repeat(16), batch: 1, of: 3, paused: false, remaining: 20, bytesDone: 0, bytesTotal: 100 })),
      retry: jest.fn(), stop: jest.fn(), subscribe: jest.fn(() => () => {}),
    };
    await renderAsync(
      <Dashboard state={initialUiState} engine={engine} peerDeviceId={peer.deviceId}
        onPickFiles={async () => []} batch={batch} />,
    );
    expect(await screen.findByText('20 more waiting - batch 1 of 3')).toBeTruthy();
    expect(batch.status).toHaveBeenCalledWith(peer.deviceId);
  });

  // Frame F3 on macOS: the label and the folder stats reach the thread composer.
  it('hands the add button label and the folder stats to the thread', async () => {
    const { engine } = spyEngine();
    await renderAsync(
      <Dashboard
        state={initialUiState}
        engine={engine}
        peerDeviceId={peer.deviceId}
        onPickFiles={async () => ['/Users/d/album']}
        folderStats={async () => ({ files: 3, bytes: 10 })}
        pickLabel="Add files or folders"
      />,
    );
    await fireEventAsync.press(await screen.findByText('Add files or folders'));
    expect(await screen.findByText('album · 3 files')).toBeTruthy();
  });

  it('hands the folder picker to the thread', async () => {
    const { engine } = spyEngine();
    const onPickFolder = jest.fn(async () => '/c/daak-send/U/album');
    await renderAsync(
      <Dashboard
        state={initialUiState}
        engine={engine}
        peerDeviceId={peer.deviceId}
        onPickFiles={async () => []}
        onPickFolder={onPickFolder}
        folderStats={async () => ({ files: 2, bytes: 10 })}
      />,
    );
    await fireEventAsync.press(await screen.findByLabelText('Add files or folders'));
    await fireEventAsync.press(screen.getByTestId('pick-menu-folder'));
    expect(await screen.findByText('album · 2 files')).toBeTruthy();
    expect(onPickFolder).toHaveBeenCalledTimes(1);
  });
});

