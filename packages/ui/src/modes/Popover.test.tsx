import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { DaakEngine, DaakEvent, DeviceInfo, QuarantineReport, SendRequest, TransferSummary } from '@daak/core';
import { Popover } from './Popover';
import { fakeEngine } from '../testing/fakeEngine';
import { initialUiState } from '../state/store';

const mk = (name: string, presence: DeviceInfo['presence'], paired = true): DeviceInfo => ({
  deviceId: name.toLowerCase().replace(/\W/g, '').padEnd(32, '0').slice(0, 32),
  name,
  addr: '192.168.1.9:40001',
  presence,
  online: presence !== 'offline',
  paired,
});
const pixel = mk('Pixel 9', 'online');
const thinkpad = mk('ThinkPad', 'online');
const iPad = mk('Living Room iPad', 'away');
const tablet = mk('Kitchen Tablet', 'offline');

const stateOf = (devices: DeviceInfo[]) => ({ ...initialUiState, devices });

const TID = 'cc'.repeat(16);
const summary = (over: Partial<TransferSummary> = {}): TransferSummary => ({
  transferId: TID,
  peerDeviceId: pixel.deviceId,
  direction: 'out',
  kind: 'media',
  state: 'active',
  bytesDone: 0,
  bytesTotal: 0,
  itemCount: 1,
  updatedAt: 10,
  ...over,
});

function spyEngine(devices: DeviceInfo[]) {
  const sent: SendRequest[] = [];
  const base = fakeEngine(devices);
  const engine: DaakEngine = {
    ...base,
    send: async (req: SendRequest) => {
      sent.push(req);
      return { transferId: TID, queued: true };
    },
  };
  return { engine, sent };
}
const emit = (engine: DaakEngine, e: DaakEvent) =>
  act(() => {
    (engine as unknown as { __handlers: Set<(e: DaakEvent) => void> }).__handlers.forEach((h) => h(e));
  });
const settle = () => act(async () => {});
const mount = (engine: DaakEngine, devices: DeviceInfo[], props: Partial<React.ComponentProps<typeof Popover>> = {}) =>
  render(<Popover state={stateOf(devices)} engine={engine} onExpand={() => {}} {...props} />);
const open = (d: DeviceInfo) => fireEvent.press(screen.getByLabelText('send-to-' + d.deviceId));
const REPORT: QuarantineReport = {
  transferId: 'dd'.repeat(16),
  itemIndex: 0,
  name: 'harbor-lighthouse.jpg',
  size: 4_400_000,
  senderName: 'Kitchen Tablet',
  senderDeviceId: 'bb'.repeat(16),
  receivedAt: 1_700_000_000,
  expected: '7f3a91c204be' + '0'.repeat(52),
  actual: '7f3a91c204c9' + '0'.repeat(52),
  heldPath: '/tmp/h',
};

describe('the panel frame', () => {
  it('is 320 wide and shows the wordmark', () => {
    const { engine } = spyEngine([pixel]);
    mount(engine, [pixel]);
    expect(StyleSheet.flatten(screen.getByTestId('popover-root').props.style).width).toBe(320);
    expect(screen.getByLabelText('Daak')).toBeTruthy();
  });

  // The header line and the row of the online device both read "On this network".
  it('shows the connection line from the engine devices', async () => {
    const { engine } = spyEngine([pixel]);
    mount(engine, [pixel]);
    await waitFor(() => expect(screen.getAllByText('On this network')).toHaveLength(2));
  });

  it('says so when no device is on the network', async () => {
    const { engine } = spyEngine([tablet]);
    mount(engine, [tablet]);
    expect(await screen.findByText('No device found on this Wi-Fi')).toBeTruthy();
  });

  it('still offers the full app as the way out', () => {
    const { engine } = spyEngine([pixel]);
    const onExpand = jest.fn();
    mount(engine, [pixel], { onExpand });
    expect(screen.getByText('Open the full app')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('open-dashboard'));
    expect(onExpand).toHaveBeenCalled();
  });

  // The blocking screens replace the panel, as they replace the tab bar.
  it('shows a blocking alert and no device list', () => {
    const { engine } = spyEngine([pixel]);
    mount(engine, [pixel], { alert: <Text>blocked</Text>, alertRouteToken: 'x' });
    expect(screen.getByText('blocked')).toBeTruthy();
    expect(screen.queryByLabelText('send-to-' + pixel.deviceId)).toBeNull();
    expect(screen.queryByLabelText('open-dashboard')).toBeNull();
  });
});

describe('the device list', () => {
  it('shows the empty state for 0 paired devices', () => {
    const { engine } = spyEngine([]);
    mount(engine, [mk('Stranger', 'online', false)]);
    expect(screen.getByText('No paired devices yet')).toBeTruthy();
    expect(screen.getByText('Pair a device on your Wi-Fi and it will show up here.')).toBeTruthy();
    expect(screen.queryByText('Stranger')).toBeNull();
  });

  it('shows 1 device with its status word', () => {
    const { engine } = spyEngine([pixel]);
    mount(engine, [pixel]);
    expect(screen.getByText('Pixel 9')).toBeTruthy();
    expect(screen.getAllByText('On this network').length).toBeGreaterThan(0);
  });

  // Review Focus 4.
  it('shows 3 of 5 devices, in the design order', () => {
    const five = [mk('Zed', 'offline'), mk('Bea', 'away'), mk('Cy', 'online'), mk('Al', 'online'), mk('Di', 'offline')];
    const { engine } = spyEngine(five);
    mount(engine, five);
    const labels = screen.getAllByLabelText(/^send-to-/).map((n) => n.props.accessibilityLabel);
    const byName = (n: string) => 'send-to-' + five.find((d) => d.name === n)!.deviceId;
    expect(labels).toEqual([byName('Al'), byName('Cy'), byName('Bea')]);
  });

  it('shows the three words of the design for the three states', () => {
    const list = [pixel, iPad, tablet];
    const { engine } = spyEngine(list);
    mount(engine, list);
    expect(screen.getByText('Away')).toBeTruthy();
    expect(screen.getByText('Not on this network')).toBeTruthy();
  });

  it('does not let the user choose an offline row', () => {
    const { engine } = spyEngine([tablet]);
    mount(engine, [tablet]);
    const row = screen.getByLabelText('send-to-' + tablet.deviceId);
    expect(row.props.accessibilityState).toMatchObject({ disabled: true });
    fireEvent.press(row);
    expect(screen.queryByLabelText('popover-back')).toBeNull();
  });

  it('lets the user choose an away row', () => {
    const { engine } = spyEngine([iPad]);
    mount(engine, [iPad]);
    open(iPad);
    expect(screen.getByLabelText('popover-back')).toBeTruthy();
    expect(screen.getByText('Living Room iPad')).toBeTruthy();
  });
});

describe('the send pane', () => {
  it('shows Add files, the note field, and a disabled Send', () => {
    const { engine } = spyEngine([pixel]);
    mount(engine, [pixel], { onPickFiles: async () => [] });
    open(pixel);
    expect(screen.getByText('Add files')).toBeTruthy();
    expect(screen.getByPlaceholderText('Or type a note')).toBeTruthy();
    expect(screen.getByLabelText('popover-send').props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getByText('Send')).toBeTruthy();
  });

  it('enables Send for a note and sends it as text', async () => {
    const { engine, sent } = spyEngine([pixel]);
    mount(engine, [pixel]);
    open(pixel);
    fireEvent.changeText(screen.getByPlaceholderText('Or type a note'), '  hello  ');
    fireEvent.press(screen.getByLabelText('popover-send'));
    await waitFor(() => expect(sent).toEqual([{ peerDeviceId: pixel.deviceId, text: 'hello' }]));
  });

  it('renders no picker when the host supplies none', () => {
    const { engine } = spyEngine([pixel]);
    mount(engine, [pixel]);
    open(pixel);
    expect(screen.queryByLabelText('popover-pick')).toBeNull();
  });

  it('sends the picked file to the tapped device, with "Send to {name}"', async () => {
    const { engine, sent } = spyEngine([pixel, thinkpad]);
    const onPickFiles = jest.fn(async () => ['/Users/d/Documents/grocery-list.txt']);
    mount(engine, [pixel, thinkpad], { onPickFiles });
    open(thinkpad);
    fireEvent.press(screen.getByLabelText('popover-pick'));
    await waitFor(() => expect(screen.getByText('grocery-list.txt')).toBeTruthy());
    expect(screen.getByText('Send to ThinkPad')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('popover-send'));
    await waitFor(() =>
      expect(sent).toEqual([{ peerDeviceId: thinkpad.deviceId, files: ['/Users/d/Documents/grocery-list.txt'] }]),
    );
  });

  // The panel supports 1 file at a time, as a radio group.
  it('chooses one file from several, and sends only that file', async () => {
    const { engine, sent } = spyEngine([pixel]);
    mount(engine, [pixel], { onPickFiles: async () => ['/a/one.pdf', '/a/two.pdf'] });
    open(pixel);
    fireEvent.press(screen.getByLabelText('popover-pick'));
    await screen.findByText('one.pdf');
    expect(screen.getByLabelText('popover-file-one.pdf').props.accessibilityState).toMatchObject({ checked: true });
    expect(screen.getByLabelText('popover-file-two.pdf').props.accessibilityState).toMatchObject({ checked: false });
    fireEvent.press(screen.getByLabelText('popover-file-two.pdf'));
    expect(screen.getByLabelText('popover-file-one.pdf').props.accessibilityState).toMatchObject({ checked: false });
    fireEvent.press(screen.getByLabelText('popover-send'));
    await waitFor(() => expect(sent).toEqual([{ peerDeviceId: pixel.deviceId, files: ['/a/two.pdf'] }]));
  });

  it('sends the file first and the note second', async () => {
    const { engine, sent } = spyEngine([pixel]);
    mount(engine, [pixel], { onPickFiles: async () => ['/a/one.pdf'] });
    open(pixel);
    fireEvent.press(screen.getByLabelText('popover-pick'));
    await screen.findByText('one.pdf');
    fireEvent.changeText(screen.getByPlaceholderText('Or type a note'), 'see attached');
    fireEvent.press(screen.getByLabelText('popover-send'));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[0]).toEqual({ peerDeviceId: pixel.deviceId, files: ['/a/one.pdf'] });
    expect(sent[1]).toEqual({ peerDeviceId: pixel.deviceId, text: 'see attached' });
  });

  it('shows the engine refusal and keeps the note', async () => {
    const engine = fakeEngine([pixel]);
    jest.spyOn(engine, 'send').mockRejectedValue(new Error('peer is not paired'));
    mount(engine, [pixel]);
    open(pixel);
    fireEvent.changeText(screen.getByPlaceholderText('Or type a note'), 'hello');
    fireEvent.press(screen.getByLabelText('popover-send'));
    expect(await screen.findByText('peer is not paired')).toBeTruthy();
    expect(screen.getByText('That send did not go through')).toBeTruthy();
    expect(screen.getByPlaceholderText('Or type a note').props.value).toBe('hello');
  });

  it('drops the staged file and note when it goes back to the device list', async () => {
    const { engine, sent } = spyEngine([pixel, thinkpad]);
    mount(engine, [pixel, thinkpad], { onPickFiles: async () => ['/tmp/a.txt'] });
    open(pixel);
    fireEvent.press(screen.getByLabelText('popover-pick'));
    await screen.findByText('a.txt');
    fireEvent.changeText(screen.getByPlaceholderText('Or type a note'), 'stale');
    fireEvent.press(screen.getByLabelText('popover-back'));
    open(thinkpad);
    expect(screen.queryByText('a.txt')).toBeNull();
    expect(screen.getByPlaceholderText('Or type a note').props.value).toBe('');
    expect(sent).toEqual([]);
  });
});

describe('the sending pane', () => {
  // The rows come AFTER the send. A row that exists at mount would be adopted
  // at once, and the user would never see the device list.
  async function startSend(engine: DaakEngine, devices: DeviceInfo[], rows: TransferSummary[]) {
    const list = jest.spyOn(engine, 'listTransfers').mockResolvedValue([]);
    mount(engine, devices, { onPickFiles: async () => ['/a/Q3-report.pdf'] });
    open(devices[0]);
    fireEvent.press(screen.getByLabelText('popover-pick'));
    await screen.findByText('Q3-report.pdf');
    list.mockResolvedValue(rows);
    fireEvent.press(screen.getByLabelText('popover-send'));
  }

  it('shows the design words and the progress of the running transfer', async () => {
    const { engine } = spyEngine([pixel]);
    await startSend(engine, [pixel], [summary({ bytesDone: 1_100_000, bytesTotal: 4_400_000 })]);
    expect(await screen.findByText('Sending to Pixel 9')).toBeTruthy();
    expect(await screen.findByText('Q3-report.pdf · 4.2 MB')).toBeTruthy();
    expect(screen.getByText('Sending over your Wi-Fi')).toBeTruthy();
    expect(await screen.findByText('25%')).toBeTruthy();
    expect(screen.getByText('Stop sending')).toBeTruthy();
  });

  it('shows no false percent before the engine reports bytes', async () => {
    const { engine } = spyEngine([pixel]);
    await startSend(engine, [pixel], [summary()]);
    await screen.findByText('Sending to Pixel 9');
    expect(screen.queryByText('0%')).toBeNull();
  });

  it('stops through engine.cancel and returns to the send pane', async () => {
    const { engine } = spyEngine([pixel]);
    const cancel = jest.spyOn(engine, 'cancel');
    await startSend(engine, [pixel], [summary()]);
    fireEvent.press(await screen.findByLabelText('popover-stop'));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(TID));
    expect(await screen.findByText('Add files')).toBeTruthy();
    expect(screen.queryByText('Sending to Pixel 9')).toBeNull();
  });

  it('shows the engine message when stop fails and stays on the pane', async () => {
    const { engine } = spyEngine([pixel]);
    jest.spyOn(engine, 'cancel').mockRejectedValue(new Error('too late'));
    await startSend(engine, [pixel], [summary()]);
    fireEvent.press(await screen.findByLabelText('popover-stop'));
    expect(await screen.findByText('too late')).toBeTruthy();
    expect(screen.getByText('Sending did not stop')).toBeTruthy();
    expect(screen.getByText('Sending to Pixel 9')).toBeTruthy();
  });

  // `retry` sets the same `result`. The failed pane must render it.
  it('shows the engine message when retry fails and stays on the failed pane', async () => {
    const { engine } = spyEngine([pixel]);
    jest.spyOn(engine, 'retry').mockRejectedValue(new Error('peer is gone'));
    await startSend(engine, [pixel], [summary({ state: 'failed' })]);
    fireEvent.press(await screen.findByLabelText('popover-retry'));
    expect(await screen.findByText('peer is gone')).toBeTruthy();
    expect(screen.getByText('That send did not start again')).toBeTruthy();
    expect(screen.getByText('That send did not go through')).toBeTruthy();
  });

  it('shows the done pane, then Back to sending returns to the send pane', async () => {
    const { engine } = spyEngine([pixel]);
    await startSend(engine, [pixel], [summary({ state: 'done', bytesDone: 4_400_000, bytesTotal: 4_400_000 })]);
    expect(await screen.findByText('Sent to Pixel 9')).toBeTruthy();
    expect(screen.getByText('Q3-report.pdf · 4.2 MB')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('popover-done-back'));
    expect(await screen.findByText('Add files')).toBeTruthy();
    expect(screen.queryByText('Sent to Pixel 9')).toBeNull();
  });

  it('shows a failed transfer with the engine text, and Try again retries it', async () => {
    const { engine } = spyEngine([pixel]);
    const retry = jest.spyOn(engine, 'retry');
    await startSend(engine, [pixel], [summary({ state: 'failed' })]);
    await screen.findByText('That send did not go through');
    emit(engine, { type: 'transfer.failed', transferId: TID, error: 'peer went away' });
    expect(await screen.findByText('peer went away')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('popover-retry'));
    await waitFor(() => expect(retry).toHaveBeenCalledWith(TID));
  });
});

// Review Focus 5. Closing the panel must not stop a running transfer.
describe('closing the panel during a transfer', () => {
  it('does not cancel on unmount', async () => {
    const { engine } = spyEngine([pixel]);
    jest.spyOn(engine, 'listTransfers').mockResolvedValue([summary()]);
    const cancel = jest.spyOn(engine, 'cancel');
    const view = mount(engine, [pixel]);
    await screen.findByText('Sending to Pixel 9');
    view.unmount();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('shows the sending pane again when the panel opens again', async () => {
    const { engine } = spyEngine([pixel]);
    jest.spyOn(engine, 'listTransfers').mockResolvedValue([summary({ bytesDone: 1, bytesTotal: 4 })]);
    const first = mount(engine, [pixel]);
    await screen.findByText('Sending to Pixel 9');
    first.unmount();
    mount(engine, [pixel]);
    expect(await screen.findByText('Sending to Pixel 9')).toBeTruthy();
    expect(screen.getByText('Stop sending')).toBeTruthy();
  });

  it('says it will send later for a queued transfer to an offline device', async () => {
    const { engine } = spyEngine([tablet]);
    jest.spyOn(engine, 'listTransfers').mockResolvedValue([summary({ peerDeviceId: tablet.deviceId, state: 'queued' })]);
    mount(engine, [tablet]);
    expect(await screen.findByText('Will send when Kitchen Tablet is back')).toBeTruthy();
    expect(screen.queryByText('Sending over your Wi-Fi')).toBeNull();
  });

  // A queued send to an offline device must not lock the panel.
  it('keeps the device list when a queued transfer waits for an offline device', async () => {
    const { engine, sent } = spyEngine([pixel, tablet]);
    jest.spyOn(engine, 'listTransfers').mockResolvedValue([summary({ peerDeviceId: tablet.deviceId, state: 'queued' })]);
    mount(engine, [pixel, tablet]);
    expect(await screen.findByText('Will send when Kitchen Tablet is back')).toBeTruthy();
    expect(screen.queryByTestId('popover-sending')).toBeNull();
    // The list is still there, and the user can pick another device and send.
    open(pixel);
    expect(screen.getByLabelText('popover-back')).toBeTruthy();
    fireEvent.changeText(screen.getByPlaceholderText('Or type a note'), 'hi');
    fireEvent.press(screen.getByLabelText('popover-send'));
    await waitFor(() => expect(sent).toEqual([{ peerDeviceId: pixel.deviceId, text: 'hi' }]));
  });

  it('stops a waiting transfer from the note', async () => {
    const { engine } = spyEngine([pixel, tablet]);
    jest.spyOn(engine, 'listTransfers').mockResolvedValue([summary({ peerDeviceId: tablet.deviceId, state: 'queued' })]);
    const cancel = jest.spyOn(engine, 'cancel');
    mount(engine, [pixel, tablet]);
    fireEvent.press(await screen.findByLabelText('popover-stop'));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(TID));
    await waitFor(() => expect(screen.queryByText('Will send when Kitchen Tablet is back')).toBeNull());
    expect(screen.getByLabelText('send-to-' + pixel.deviceId)).toBeTruthy();
  });
});

describe('the held-back card', () => {
  it('shows no card when nothing is held', async () => {
    const { engine } = spyEngine([pixel]);
    mount(engine, [pixel]);
    await settle();
    expect(screen.queryByText('Held back')).toBeNull();
  });

  it('shows the newest item with its name and size, and expands the explanation', async () => {
    const { engine } = spyEngine([pixel]);
    jest.spyOn(engine, 'listQuarantineReports').mockResolvedValue([REPORT]);
    mount(engine, [pixel], { deviceNoun: 'Mac' });
    expect(await screen.findByText('Held back')).toBeTruthy();
    expect(screen.getByText('harbor-lighthouse.jpg · 4.2 MB')).toBeTruthy();
    expect(screen.getByText('What does this mean?')).toBeTruthy();
    expect(screen.queryByTestId('popover-held-why')).toBeNull();
    fireEvent.press(screen.getByLabelText('popover-held-toggle'));
    expect(
      screen.getByText(
        'Its check did not match what the sender promised, so it was not opened. Nothing was deleted and nothing left this Mac.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Fingerprint it should have')).toBeTruthy();
    expect(screen.getByText('7f3a 91c2 04be')).toBeTruthy();
    expect(screen.getByText('Fingerprint it has')).toBeTruthy();
    expect(screen.getByText('7f3a 91c2 04c9')).toBeTruthy();
  });

  it('shows "Not recorded" for a name the device did not record', async () => {
    const { engine } = spyEngine([pixel]);
    jest.spyOn(engine, 'listQuarantineReports').mockResolvedValue([{ ...REPORT, name: null, size: null }]);
    mount(engine, [pixel]);
    expect(await screen.findByText('Not recorded')).toBeTruthy();
  });

  // Review Focus 5. An item arrives while the panel is open.
  it('shows an item that is held back while the panel is open', async () => {
    const { engine } = spyEngine([pixel]);
    const list = jest.spyOn(engine, 'listQuarantineReports').mockResolvedValue([]);
    mount(engine, [pixel]);
    await settle();
    expect(screen.queryByText('Held back')).toBeNull();
    list.mockResolvedValue([REPORT]);
    emit(engine, { type: 'transfer.item', transferId: REPORT.transferId, itemIndex: 0, state: 'quarantined' });
    expect(await screen.findByText('Held back')).toBeTruthy();
  });
});
