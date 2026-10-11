import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import type { DaakEvent, DeviceInfo, TransferSummary } from '@daak/core';
import { EngineProvider } from '../EngineContext';
import { DashboardScreen } from './DashboardScreen';
import { fakeEngine } from '../testing/fakeEngine';
import { threadItem, threadPage } from '../testing/threadFixtures';
import { whenLabel } from '../components/Bubble';
import { setSelfPresenceLocal } from '../state/selfPresence';

afterEach(() => act(() => setSelfPresenceLocal('online')));

const dev = (name: string, presence: DeviceInfo['presence'], extra: Partial<DeviceInfo> = {}): DeviceInfo => ({
  deviceId: (name.charCodeAt(0).toString(16).padStart(2, '0')).repeat(16),
  name,
  addr: '',
  presence,
  online: presence !== 'offline',
  paired: true,
  ...extra,
});

const emit = (engine: ReturnType<typeof fakeEngine>, e: DaakEvent) =>
  act(() => {
    (engine as unknown as { __handlers: Set<(e: DaakEvent) => void> }).__handlers.forEach((h) => h(e));
  });

const mount = (engine = fakeEngine([]), props: React.ComponentProps<typeof DashboardScreen> = {}) =>
  render(
    <EngineProvider engine={engine}>
      <DashboardScreen {...props} />
    </EngineProvider>,
  );

describe('DashboardScreen (Devices)', () => {
  it('shows the lead text and this device', async () => {
    const engine = fakeEngine([]);
    mount(engine);
    expect(screen.getByText("Everything on your Wi-Fi. Tap a device you've paired with to open your conversation, or pair a new one.")).toBeTruthy();
    expect(await screen.findByText('Test Device')).toBeTruthy();
    // Design v2: the status of this device reads "On this network".
    expect(within(screen.getByTestId('this-device-status')).getByText('On this network')).toBeTruthy();
    expect(screen.queryByText('Ready to send')).toBeNull();
  });

  it('shows Away for this device after the user turns presence off in Settings', async () => {
    mount(fakeEngine([]));
    await screen.findByText('Test Device');
    act(() => setSelfPresenceLocal('away'));
    expect(within(screen.getByTestId('this-device-status')).getByText('Away')).toBeTruthy();
  });

  it('lists paired devices online first, with a word for each state', async () => {
    const engine = fakeEngine([dev('Kitchen Tablet', 'offline'), dev('Living Room iPad', 'away'), dev('Darshit iPhone', 'online')]);
    mount(engine);
    expect(await screen.findByText('Darshit iPhone')).toBeTruthy();
    const titles = screen.getAllByText(/Kitchen Tablet|Living Room iPad|Darshit iPhone/).map((n) => n.props.children);
    expect(titles).toEqual(['Darshit iPhone', 'Living Room iPad', 'Kitchen Tablet']);
    // This device and the online paired device both read "On this network".
    expect(screen.getAllByText('On this network')).toHaveLength(2);
    expect(screen.getByText('Away')).toBeTruthy();
    expect(screen.getByText('Not on this network')).toBeTruthy();
  });

  // The engine queues a send, so an offline device opens its thread too.
  it('opens the thread of an offline device', async () => {
    const off = dev('Kitchen Tablet', 'offline');
    const onOpenThread = jest.fn();
    mount(fakeEngine([off]), { onOpenThread });
    fireEvent.press(await screen.findByTestId('open-' + off.deviceId));
    expect(onOpenThread).toHaveBeenCalledWith(off);
  });

  it('shows the empty state and a Pair a device button when nothing is paired', async () => {
    const onPair = jest.fn();
    mount(fakeEngine([]), { onPair });
    expect(await screen.findByText('No paired devices yet')).toBeTruthy();
    expect(screen.getByText('Pair a device on your Wi-Fi and it will show up here.')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('pair-a-device-empty'));
    expect(onPair).toHaveBeenCalledTimes(1);
  });

  it('lists a nearby unpaired device with a Pair button', async () => {
    const near = dev('Ana Pixel', 'online', { paired: false });
    const onPair = jest.fn();
    mount(fakeEngine([near]), { onPair });
    // The section title and the row status carry the same design words, so the
    // query returns both.
    expect((await screen.findAllByText('Nearby, not paired yet')).length).toBe(2);
    fireEvent.press(screen.getByLabelText('pair-with-' + near.deviceId));
    expect(onPair).toHaveBeenCalled();
  });

  // HEAD 824b3d7: the engine keeps a new pairing pending until the user
  // confirms the SAS. A pending peer has paired false. It is not a paired
  // device, so it must not appear in "Your devices" and must not open a thread.
  it('lists a pending pairing as nearby and not paired, with no thread', async () => {
    const pending = dev('Ana Pixel', undefined, { paired: false, online: true });
    const onOpenThread = jest.fn();
    mount(fakeEngine([pending]), { onOpenThread });
    expect((await screen.findAllByText('Nearby, not paired yet')).length).toBe(2);
    expect(screen.getByText('No paired devices yet')).toBeTruthy();
    expect(screen.queryByTestId('open-' + pending.deviceId)).toBeNull();
    expect(onOpenThread).not.toHaveBeenCalled();
  });

  // The user confirms the SAS: the engine emits pairing.done and sets paired true.
  it('moves a peer into Your devices on pairing.done', async () => {
    const peer = dev('Ana Pixel', undefined, { paired: false, online: true });
    const engine = fakeEngine([peer]);
    mount(engine, { onOpenThread: jest.fn() });
    await screen.findAllByText('Nearby, not paired yet');
    jest.spyOn(engine, 'devices').mockResolvedValue([{ ...peer, paired: true, presence: 'online' }]);
    emit(engine, { type: 'pairing.done', deviceId: peer.deviceId });
    expect(await screen.findByTestId('open-' + peer.deviceId)).toBeTruthy();
    expect(screen.queryByText('Nearby, not paired yet')).toBeNull();
  });

  it('offers Pair a new device and the check link only when the host gives the callbacks', async () => {
    const onPair = jest.fn();
    const onCheckConnection = jest.fn();
    const { unmount } = mount(fakeEngine([dev('Pixel', 'online')]), { onPair, onCheckConnection });
    fireEvent.press(await screen.findByLabelText('pair-a-device'));
    fireEvent.press(screen.getByLabelText('devices-check-connection'));
    expect(onPair).toHaveBeenCalled();
    expect(onCheckConnection).toHaveBeenCalled();
    unmount();
    mount(fakeEngine([dev('Pixel', 'online')]));
    await screen.findByText('Pixel');
    expect(screen.queryByLabelText('pair-a-device')).toBeNull();
    expect(screen.queryByLabelText('devices-check-connection')).toBeNull();
  });

  // After a relaunch no outbox.queued event has fired yet. The count comes from listTransfers.
  it('seeds the waiting badge from the queued outbound transfers', async () => {
    const peer = dev('Pixel', 'offline');
    const engine = fakeEngine([peer]);
    const row = (id: string): TransferSummary => ({
      transferId: id.repeat(16), peerDeviceId: peer.deviceId, direction: 'out', kind: 'media',
      state: 'queued', bytesDone: 0, bytesTotal: 5, itemCount: 1, updatedAt: 1,
    });
    jest.spyOn(engine, 'listTransfers').mockResolvedValue([row('b0'), row('b1')]);
    mount(engine);
    expect(await screen.findByText('2 waiting')).toBeTruthy();
    emit(engine, { type: 'outbox.queued', deviceId: peer.deviceId, queued: 3 });
    expect(await screen.findByText('3 waiting')).toBeTruthy();
  });

  it('refetches the list on device.presence', async () => {
    const peer = dev('Pixel', 'online');
    const engine = fakeEngine([peer]);
    const spy = jest.spyOn(engine, 'devices');
    mount(engine, { onOpenThread: jest.fn() });
    await screen.findByTestId('open-' + peer.deviceId);
    spy.mockResolvedValue([{ ...peer, presence: 'away' }]);
    emit(engine, { type: 'device.presence', deviceId: peer.deviceId, presence: 'away' });
    expect(await screen.findByText('Away')).toBeTruthy();
  });

  it('says why the list is empty when the engine rejects', async () => {
    const engine = fakeEngine([]);
    jest.spyOn(engine, 'devices').mockRejectedValue(new Error('engine not started'));
    mount(engine);
    expect(await screen.findByText('engine not started')).toBeTruthy();
  });

  it('asks the user to pick a device for an OS share', async () => {
    mount(fakeEngine([dev('Pixel', 'online')]), { pendingShare: { fileCount: 2, hasText: true } });
    expect(await screen.findByText('Pick a device for what you shared')).toBeTruthy();
    expect(screen.getByText('2 files and a note are ready. Tap a device to send them.')).toBeTruthy();
  });

  // Design renderDevices (index.html:1381-1397): each paired row shows the
  // last item and its time. One limit-1 read for each paired device.
  it('shows the last item and its time on each paired row', async () => {
    const a = dev('Kitchen Tablet', 'online');
    const b = dev('Living Room iPad', 'away');
    const at = 1_700_000_000;
    const engine = fakeEngine([a, b]);
    const list = jest.spyOn(engine, 'listThread').mockImplementation(async (id: string) =>
      id === a.deviceId
        ? threadPage([threadItem({ type: 'file', text: null, name: 'Q3-report.pdf', at })])
        : threadPage([]),
    );
    mount(engine, { onOpenThread: jest.fn() });
    expect(await screen.findByText('Q3-report.pdf')).toBeTruthy();
    expect(screen.getByText(whenLabel(at))).toBeTruthy();
    expect(screen.getByText('No items yet')).toBeTruthy();
    expect(list).toHaveBeenCalledWith(a.deviceId, { limit: 1 });
    expect(list).toHaveBeenCalledWith(b.deviceId, { limit: 1 });
  });
});

