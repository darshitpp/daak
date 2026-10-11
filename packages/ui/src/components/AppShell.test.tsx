import React from 'react';
import { Text } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { DaakEngine, DeviceInfo } from '@daak/core';
import { EngineProvider } from '../EngineContext';
import { fakeEngine } from '../testing/fakeEngine';
import { threadItem, threadPage } from '../testing/threadFixtures';
import { AppShell } from './AppShell';

const peer: DeviceInfo = { deviceId: 'aa'.repeat(16), name: 'Pixel 9', addr: '', online: true, presence: 'online', paired: true };
const second: DeviceInfo = { deviceId: 'cc'.repeat(16), name: 'ThinkPad', addr: '', online: true, presence: 'online', paired: true };
const TID = 'bb'.repeat(16);

function shell(engine: DaakEngine, props: React.ComponentProps<typeof AppShell> = {}) {
  const ui = (p: React.ComponentProps<typeof AppShell>) => (
    <EngineProvider engine={engine}>
      <AppShell {...p} />
    </EngineProvider>
  );
  const utils = render(ui(props));
  return { ...utils, again: (p: React.ComponentProps<typeof AppShell>) => utils.rerender(ui(p)) };
}

describe('AppShell tabs', () => {
  it('opens on Devices and shows two tabs only', async () => {
    shell(fakeEngine([peer]));
    expect(await screen.findByText('Your devices')).toBeTruthy();
    expect(screen.getByTestId('tab-devices')).toBeTruthy();
    expect(screen.getByTestId('tab-settings')).toBeTruthy();
    for (const gone of ['tab-send', 'tab-inbox', 'tab-history', 'tab-transfers']) {
      expect(screen.queryByTestId(gone)).toBeNull();
    }
  });

  // An app that injects the control into Settings but forgets AppShell shows a
  // Settings screen with no affordance on it.
  it('threads a background slot through to the Settings tab', async () => {
    shell(fakeEngine([]), { background: <Text>allow-bg</Text> });
    fireEvent.press(screen.getByTestId('tab-settings'));
    expect(await screen.findByText('allow-bg')).toBeTruthy();
  });

  it('threads a pair slot through to Pairing and routes out again', async () => {
    shell(fakeEngine([]), { pair: <Text>pair-ui</Text> });
    fireEvent.press(await screen.findByTestId('pair-a-device'));
    expect(screen.getByText('pair-ui')).toBeTruthy();
    fireEvent.press(screen.getByTestId('pair-back'));
    expect(screen.queryByText('pair-ui')).toBeNull();
    expect(screen.getByTestId('pair-a-device')).toBeTruthy();
  });

  it('routes a pair link into the pair slot', () => {
    shell(fakeEngine([]), { pair: <Text>pair-ui</Text>, pairBundle: '{"cbor":"aabb"}' });
    expect(screen.getByText('pair-ui')).toBeTruthy();
  });
});

describe('AppShell thread route', () => {
  it('opens a thread from a device row, hides the tab bar, and sends to that peer', async () => {
    const engine = fakeEngine([peer, second]);
    const send = jest.spyOn(engine, 'send').mockResolvedValue({ transferId: TID, queued: false });
    shell(engine);
    fireEvent.press(await screen.findByTestId('open-' + second.deviceId));
    expect(await screen.findByTestId('thread-back')).toBeTruthy();
    expect(screen.queryByTestId('tab-devices')).toBeNull();
    fireEvent.changeText(await screen.findByPlaceholderText('Or type a note'), 'hi');
    fireEvent.press(screen.getByTestId('send'));
    await waitFor(() => expect(send).toHaveBeenCalledWith({ peerDeviceId: second.deviceId, text: 'hi' }));
    fireEvent.press(screen.getByTestId('thread-back'));
    expect(await screen.findByTestId('tab-devices')).toBeTruthy();
  });

  it('opens a thread for an offline paired device', async () => {
    const off = { ...peer, presence: 'offline' as const, online: false };
    shell(fakeEngine([off]));
    fireEvent.press(await screen.findByTestId('open-' + off.deviceId));
    expect(await screen.findByText('Not on this network')).toBeTruthy();
    expect(await screen.findByPlaceholderText('Or type a note')).toBeTruthy();
  });

  it('routes a send link to the thread of that device, seeded with the note', async () => {
    const engine = fakeEngine([peer, second]);
    const send = jest.spyOn(engine, 'send').mockResolvedValue({ transferId: TID, queued: false });
    shell(engine, { initialPeerDeviceId: peer.deviceId, initialText: 'from a link' });
    expect(await screen.findByDisplayValue('from a link')).toBeTruthy();
    fireEvent.press(await screen.findByTestId('send'));
    await waitFor(() => expect(send).toHaveBeenCalledWith({ peerDeviceId: peer.deviceId, text: 'from a link' }));
  });

  // The link is the more recent instruction. A note typed for the old target
  // must not go to the new one (the composer remounts).
  it('lets a later link replace the open thread and clears the old note', async () => {
    const engine = fakeEngine([peer, second]);
    const { again } = shell(engine, { initialPeerDeviceId: second.deviceId });
    fireEvent.changeText(await screen.findByPlaceholderText('Or type a note'), 'for the old peer');
    again({ initialPeerDeviceId: peer.deviceId, initialText: '' });
    await waitFor(() => expect(screen.queryByDisplayValue('for the old peer')).toBeNull());
    expect(await screen.findByText('Pixel 9')).toBeTruthy();
  });

  // Review Focus 4.
  it('shows Not paired any more for a link that names an unknown device', async () => {
    const engine = fakeEngine([peer]);
    const send = jest.spyOn(engine, 'send');
    shell(engine, { initialPeerDeviceId: 'dd'.repeat(16), initialText: 'x' });
    expect(await screen.findByText('Not paired any more')).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('thread-back'));
    expect(await screen.findByTestId('tab-devices')).toBeTruthy();
  });

  it('holds an OS share on Devices until the user picks a device', async () => {
    const engine = fakeEngine([peer]);
    const send = jest.spyOn(engine, 'send').mockResolvedValue({ transferId: TID, queued: false });
    shell(engine, { initialText: 'shared note', initialFiles: ['/Documents/photo.png'] });
    expect(await screen.findByText('Pick a device for what you shared')).toBeTruthy();
    fireEvent.press(await screen.findByTestId('open-' + peer.deviceId));
    expect(await screen.findByDisplayValue('shared note')).toBeTruthy();
    expect(screen.getByText('photo.png')).toBeTruthy();
    fireEvent.press(await screen.findByTestId('send'));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send).toHaveBeenNthCalledWith(1, { peerDeviceId: peer.deviceId, files: ['/Documents/photo.png'] });
    expect(send).toHaveBeenNthCalledWith(2, { peerDeviceId: peer.deviceId, text: 'shared note' });
    fireEvent.press(screen.getByTestId('thread-back'));
    await screen.findByText('Your devices');
    expect(screen.queryByText('Pick a device for what you shared')).toBeNull();
  });
});

describe('AppShell held route', () => {
  it('opens the held screen from a held bubble and goes back to the thread', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage([
      threadItem({ type: 'file', text: null, name: 'bad.jpg', state: 'quarantined', transferId: TID, itemIndex: 1 }),
    ]));
    const report = jest.spyOn(engine, 'quarantineReport');
    shell(engine, { initialPeerDeviceId: peer.deviceId });
    fireEvent.press(await screen.findByLabelText('Review bad.jpg'));
    expect(await screen.findByTestId('quarantine-route')).toBeTruthy();
    expect(screen.queryByTestId('tab-devices')).toBeNull();
    await waitFor(() => expect(report).toHaveBeenCalledWith(TID, 1));
    fireEvent.press(screen.getByTestId('onb-back'));
    expect(await screen.findByTestId('thread-back')).toBeTruthy();
  });

  // The thread stays mounted under the held screen. A remount would drop the
  // note, the picked files, the loaded pages, and the scroll position.
  it('keeps the typed note and the picked files after a round trip to the held screen', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage([
      threadItem({ type: 'file', text: null, name: 'bad.jpg', state: 'quarantined', transferId: TID, itemIndex: 1 }),
    ]));
    shell(engine, { initialPeerDeviceId: peer.deviceId, onPickFiles: async () => ['/Users/d/a.pdf'] });
    fireEvent.changeText(await screen.findByPlaceholderText('Or type a note'), 'half written');
    fireEvent.press(screen.getByTestId('pick-files'));
    await screen.findByText('a.pdf');
    fireEvent.press(await screen.findByLabelText('Review bad.jpg'));
    expect(await screen.findByTestId('quarantine-route')).toBeTruthy();
    fireEvent.press(screen.getByTestId('onb-back'));
    expect(await screen.findByDisplayValue('half written')).toBeTruthy();
    expect(screen.getByText('a.pdf')).toBeTruthy();
  });

  // P4 Task 8. The delete sentence names the device noun the shell was given.
  it('gives the held screen the shell device noun', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage([
      threadItem({ type: 'file', text: null, name: 'bad.jpg', state: 'quarantined', transferId: TID, itemIndex: 1 }),
    ]));
    shell(engine, { initialPeerDeviceId: peer.deviceId, deviceNoun: 'Mac' });
    fireEvent.press(await screen.findByLabelText('Review bad.jpg'));
    expect(await screen.findByTestId('quarantine-route')).toBeTruthy();
    expect(screen.getByLabelText('Back to conversation')).toBeTruthy();
    fireEvent.press(screen.getByTestId('quarantine-delete'));
    expect(screen.getByText('It was never opened. Deleting it only clears the holding area on this Mac.')).toBeTruthy();
    fireEvent.press(screen.getByTestId('quarantine-delete-confirm'));
    // The design returns to the conversation after the delete.
    await waitFor(() => expect(screen.queryByTestId('quarantine-route')).toBeNull());
  });
});

describe('AppShell tokens', () => {
  it('lands on Settings for a settings token, and again for a repeat', async () => {
    const engine = fakeEngine([peer]);
    const { again } = shell(engine);
    await screen.findByText('Your devices');
    again({ settingsRouteToken: '1' });
    expect(await screen.findByTestId('save-name')).toBeTruthy();
    fireEvent.press(screen.getByTestId('tab-devices'));
    await screen.findByText('Your devices');
    again({ settingsRouteToken: '2' });
    expect(await screen.findByTestId('save-name')).toBeTruthy();
  });

  // A tapped [Open] notification. The host may name the sender.
  it('routes a notification token to Devices, or to the sender thread, and again on a repeat', async () => {
    const engine = fakeEngine([peer]);
    const { again } = shell(engine);
    fireEvent.press(screen.getByTestId('tab-settings'));
    await screen.findByTestId('save-name');
    again({ inboxRouteToken: '1' });
    expect(await screen.findByText('Your devices')).toBeTruthy();
    again({ inboxRouteToken: '2', inboxPeerDeviceId: peer.deviceId });
    expect(await screen.findByTestId('thread-back')).toBeTruthy();
    fireEvent.press(screen.getByTestId('thread-back'));
    again({ inboxRouteToken: '3', inboxPeerDeviceId: peer.deviceId });
    expect(await screen.findByTestId('thread-back')).toBeTruthy();
  });

  it('shows a blocking alert instead of the tabs', async () => {
    shell(fakeEngine([peer]), { alert: <Text>blocked</Text>, alertRouteToken: 'p' });
    expect(screen.getByText('blocked')).toBeTruthy();
    expect(screen.queryByTestId('tab-devices')).toBeNull();
  });

  // The host hook must be threaded through the shell to Settings.
  it('threads onUnpair from the shell to the Settings remove sheet', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'revokePairing').mockResolvedValue();
    const onUnpair = jest.fn();
    shell(engine, { onUnpair });
    fireEvent.press(screen.getByTestId('tab-settings'));
    fireEvent.press(await screen.findByTestId('remove-' + peer.deviceId));
    fireEvent.press(screen.getByTestId('confirm-remove'));
    await waitFor(() => expect(onUnpair).toHaveBeenCalledWith(peer));
  });

  it('threads settingsHost from the shell to the Arrival switches', async () => {
    const load = jest.fn(async () => ({ arrival: true }));
    shell(fakeEngine([]), { settingsHost: { notifyPrefs: { load, save: async () => {} } }, deviceNoun: 'phone' });
    fireEvent.press(screen.getByTestId('tab-settings'));
    expect(await screen.findByText('Shows a message on this phone.')).toBeTruthy();
    expect(load).toHaveBeenCalled();
  });


});

// The macOS window draws the design sidebar on EVERY route (design: macos.html,
// `.sidebar`), with the version footer at the bottom. The header with the two
// segments is gone.
describe('AppShell desktop layout', () => {
  const CHROME = { title: 'Daak for Mac', version: 'Version 0.4.2 (build 1180)' };
  const devicesSelected = () => screen.getByLabelText('Devices').props.accessibilityState;
  const settingsSelected = () => screen.getByLabelText('Settings').props.accessibilityState;

  it('draws the sidebar and its version footer on the Devices route', async () => {
    shell(fakeEngine([peer]), { layout: 'desktop', windowChrome: CHROME });
    expect(await screen.findByTestId('window-sidebar')).toBeTruthy();
    expect(screen.getByText('Version 0.4.2 (build 1180)')).toBeTruthy();
    expect(devicesSelected()).toMatchObject({ selected: true });
    expect(screen.queryByTestId('tab-devices')).toBeNull();
  });

  it('keeps the sidebar on Settings and highlights Settings', async () => {
    shell(fakeEngine([peer]), { layout: 'desktop', windowChrome: CHROME, settingsRouteToken: '1' });
    expect(await screen.findByTestId('save-name')).toBeTruthy();
    expect(screen.getByTestId('window-sidebar')).toBeTruthy();
    expect(settingsSelected()).toMatchObject({ selected: true });
  });

  it('routes from the sidebar to Settings', async () => {
    shell(fakeEngine([peer]), { layout: 'desktop', windowChrome: CHROME });
    fireEvent.press(await screen.findByTestId('side-settings'));
    expect(await screen.findByTestId('save-name')).toBeTruthy();
    fireEvent.press(screen.getByTestId('side-devices'));
    expect(await screen.findByText('Your devices')).toBeTruthy();
  });

  it('keeps the sidebar inside a thread, and highlights Devices', async () => {
    shell(fakeEngine([peer]), { layout: 'desktop', windowChrome: CHROME, initialPeerDeviceId: peer.deviceId });
    await screen.findByTestId('thread-back');
    expect(screen.getByTestId('window-sidebar')).toBeTruthy();
    expect(devicesSelected()).toMatchObject({ selected: true });
  });

  it('keeps the sidebar on the pair route, and highlights Devices', async () => {
    shell(fakeEngine([peer]), { layout: 'desktop', windowChrome: CHROME, pair: <Text>pair-ui</Text>, pairBundle: '{"cbor":"aabb"}' });
    expect(await screen.findByText('pair-ui')).toBeTruthy();
    expect(screen.getByTestId('window-sidebar')).toBeTruthy();
    expect(devicesSelected()).toMatchObject({ selected: true });
  });

  it('keeps the sidebar on the held route, and highlights Devices', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage([
      threadItem({ type: 'file', text: null, name: 'bad.jpg', state: 'quarantined', transferId: TID, itemIndex: 1 }),
    ]));
    shell(engine, { layout: 'desktop', windowChrome: CHROME, initialPeerDeviceId: peer.deviceId });
    fireEvent.press(await screen.findByLabelText('Review bad.jpg'));
    expect(await screen.findByTestId('quarantine-route')).toBeTruthy();
    expect(screen.getByTestId('window-sidebar')).toBeTruthy();
    expect(devicesSelected()).toMatchObject({ selected: true });
  });

  it('hides the sidebar while a notice shows', async () => {
    shell(fakeEngine([peer]), { layout: 'desktop', windowChrome: CHROME, alert: <Text>blocked</Text>, alertRouteToken: 'p' });
    expect(screen.getByText('blocked')).toBeTruthy();
    expect(screen.queryByTestId('window-sidebar')).toBeNull();
  });
});

