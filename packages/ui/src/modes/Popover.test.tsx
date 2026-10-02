import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Popover } from './Popover';
import { fakeEngine } from '../testing/fakeEngine';
import { initialUiState } from '../state/store';
import type { DaakEngine, DeviceInfo, SendRequest } from '@daak/core';

const pixel: DeviceInfo = { deviceId: 'aa'.repeat(16), name: 'Pixel 9', addr: '192.168.1.9:40001', online: true };
const thinkpad: DeviceInfo = { deviceId: 'bb'.repeat(16), name: 'ThinkPad', addr: '192.168.1.10:40001', online: true };

function spyEngine(devices: DeviceInfo[]): { engine: DaakEngine; sent: SendRequest[] } {
  const sent: SendRequest[] = [];
  const engine = fakeEngine(devices);
  return {
    engine: {
      ...engine,
      send: async (req: SendRequest) => {
        sent.push(req);
        return { transferId: 'cc'.repeat(16), queued: true };
      },
    },
    sent,
  };
}

const state = { ...initialUiState, devices: [pixel, thinkpad] };

// The prototype's popover sends from the panel itself: tap a device, tap a
// file, tap Send. Two devices render the same row, so the peerDeviceId in the
// send is the only thing that proves WHICH machine got the file.
it('sends the picked file to the tapped device', async () => {
  const { engine, sent } = spyEngine([pixel, thinkpad]);
  const onPickFiles = jest.fn(async () => ['/Users/d/Documents/grocery-list.txt']);
  render(<Popover state={state} engine={engine} onExpand={() => {}} onPickFiles={onPickFiles} />);
  fireEvent.press(screen.getByLabelText('send-to-' + thinkpad.deviceId));
  fireEvent.press(screen.getByLabelText('popover-pick'));
  await waitFor(() => expect(screen.getByText('grocery-list.txt')).toBeTruthy());
  fireEvent.press(screen.getByLabelText('popover-send'));
  await waitFor(() =>
    expect(sent).toEqual([{ peerDeviceId: thinkpad.deviceId, files: ['/Users/d/Documents/grocery-list.txt'] }]),
  );
  expect(onPickFiles).toHaveBeenCalled();
});

// A panel that renders the Send step with nothing to send is a control that
// cannot be pressed; the engine also refuses an empty send.
it('offers no Send before a file is chosen', () => {
  const { engine } = spyEngine([pixel]);
  render(<Popover state={state} engine={engine} onExpand={() => {}} onPickFiles={async () => []} />);
  fireEvent.press(screen.getByLabelText('send-to-' + pixel.deviceId));
  expect(screen.queryByLabelText('popover-send')).toBeNull();
});

// A host with no picker has nowhere to pick a file, so the step must not offer
// a picker button that opens nothing.
it('renders no picker when the host supplies none', () => {
  const { engine } = spyEngine([pixel]);
  render(<Popover state={state} engine={engine} onExpand={() => {}} />);
  fireEvent.press(screen.getByLabelText('send-to-' + pixel.deviceId));
  expect(screen.queryByLabelText('popover-pick')).toBeNull();
});

// A rejected send must be visible: the popover is the whole surface, so a
// silent failure here is a send the user believes went out.
it('shows the engine refusal instead of a bare failure', async () => {
  const engine = fakeEngine([pixel]);
  jest.spyOn(engine, 'send').mockRejectedValue(new Error('peer is not paired'));
  render(<Popover state={state} engine={engine} onExpand={() => {}} onPickFiles={async () => ['/tmp/a.txt']} />);
  fireEvent.press(screen.getByLabelText('send-to-' + pixel.deviceId));
  fireEvent.press(screen.getByLabelText('popover-pick'));
  await waitFor(() => expect(screen.getByLabelText('popover-send')).toBeTruthy());
  fireEvent.press(screen.getByLabelText('popover-send'));
  await waitFor(() => expect(screen.getByText('peer is not paired')).toBeTruthy());
});

// Back returns to the device list and drops the staged file, so the panel does
// not keep sending the previous pick to a different device.
it('drops the staged file when it goes back to the device list', async () => {
  const { engine, sent } = spyEngine([pixel, thinkpad]);
  render(<Popover state={state} engine={engine} onExpand={() => {}} onPickFiles={async () => ['/tmp/a.txt']} />);
  fireEvent.press(screen.getByLabelText('send-to-' + pixel.deviceId));
  fireEvent.press(screen.getByLabelText('popover-pick'));
  await waitFor(() => expect(screen.getByLabelText('popover-send')).toBeTruthy());
  fireEvent.press(screen.getByLabelText('popover-back'));
  fireEvent.press(screen.getByLabelText('send-to-' + thinkpad.deviceId));
  expect(screen.queryByText('a.txt')).toBeNull();
  fireEvent.press(screen.getByLabelText('popover-pick'));
  await waitFor(() => expect(screen.getByLabelText('popover-send')).toBeTruthy());
  fireEvent.press(screen.getByLabelText('popover-send'));
  await waitFor(() => expect(sent).toEqual([{ peerDeviceId: thinkpad.deviceId, files: ['/tmp/a.txt'] }]));
});

it('still offers the full app as the way out', () => {
  const { engine } = spyEngine([pixel]);
  const onExpand = jest.fn();
  render(<Popover state={state} engine={engine} onExpand={onExpand} />);
  fireEvent.press(screen.getByLabelText('open-dashboard'));
  expect(onExpand).toHaveBeenCalled();
});
