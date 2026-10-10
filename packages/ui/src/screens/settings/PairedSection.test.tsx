import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { DaakEvent, DeviceInfo } from '@daak/core';
import { EngineProvider } from '../../EngineContext';
import { fakeEngine } from '../../testing/fakeEngine';
import { ToastProvider } from '../../components/Toast';
import { PairedSection } from './PairedSection';

const dev = (name: string, presence: DeviceInfo['presence']): DeviceInfo => ({
  deviceId: name.charCodeAt(0).toString(16).padStart(2, '0').repeat(16),
  name, addr: '', presence, online: presence !== 'offline', paired: true,
});
const iphone = dev('Darshit iPhone', 'online');
const ipad = dev('Living Room iPad', 'away');
const tablet = dev('Kitchen Tablet', 'offline');

const mount = (engine = fakeEngine([tablet, ipad, iphone]), onUnpair?: (d: DeviceInfo) => void) =>
  render(
    <EngineProvider engine={engine}>
      <ToastProvider>
        <PairedSection onUnpair={onUnpair} />
      </ToastProvider>
    </EngineProvider>,
  );

describe('PairedSection', () => {
  it('lists each paired device with its status word and a Remove button', async () => {
    mount();
    expect(await screen.findByText('Darshit iPhone')).toBeTruthy();
    expect(screen.getByText('On this network')).toBeTruthy();
    expect(screen.getByText('Away')).toBeTruthy();
    expect(screen.getByText('Not on this network')).toBeTruthy();
    expect(screen.getAllByText('Remove')).toHaveLength(3);
  });

  it('does not list a device that is only nearby', async () => {
    mount(fakeEngine([iphone, { ...ipad, paired: false }]));
    await screen.findByText('Darshit iPhone');
    expect(screen.queryByText('Living Room iPad')).toBeNull();
  });

  it('shows the empty state when nothing is paired', async () => {
    mount(fakeEngine([]));
    expect(await screen.findByText('No devices paired')).toBeTruthy();
    expect(screen.getByText('Pair one on the Devices tab to start sending.')).toBeTruthy();
  });

  it('asks before it removes, with the design words', async () => {
    const engine = fakeEngine([iphone]);
    const revoke = jest.spyOn(engine, 'revokePairing');
    mount(engine);
    fireEvent.press(await screen.findByTestId('remove-' + iphone.deviceId));
    expect(screen.getByText('Unpair Darshit iPhone?')).toBeTruthy();
    expect(screen.getByText('You will need to check the same number again to send anything to it later.')).toBeTruthy();
    expect(screen.getByText('Remove Darshit iPhone')).toBeTruthy();
    expect(revoke).not.toHaveBeenCalled();
  });

  it('keeps the pairing when the user picks Keep it', async () => {
    const engine = fakeEngine([iphone]);
    const revoke = jest.spyOn(engine, 'revokePairing');
    mount(engine);
    fireEvent.press(await screen.findByTestId('remove-' + iphone.deviceId));
    fireEvent.press(screen.getByLabelText('keep-paired'));
    expect(revoke).not.toHaveBeenCalled();
    expect(screen.queryByText('Unpair Darshit iPhone?')).toBeNull();
  });

  it('revokes once, calls the host hook, and toasts that the device is unpaired', async () => {
    const engine = fakeEngine([iphone]);
    const revoke = jest.spyOn(engine, 'revokePairing').mockResolvedValue();
    const onUnpair = jest.fn();
    mount(engine, onUnpair);
    fireEvent.press(await screen.findByTestId('remove-' + iphone.deviceId));
    fireEvent.press(screen.getByLabelText('confirm-remove'));
    await waitFor(() => expect(revoke).toHaveBeenCalledTimes(1));
    expect(revoke).toHaveBeenCalledWith(iphone.deviceId);
    await waitFor(() => expect(onUnpair).toHaveBeenCalledWith(iphone));
    // The design toast "{name} unpaired". It is not an inline note.
    expect(await screen.findByText('Darshit iPhone unpaired')).toBeTruthy();
    expect(screen.getByTestId('toast')).toBeTruthy();
    expect(screen.queryByTestId('paired-result')).toBeNull();
  });

  // HEAD 824b3d7: revoke_pairing dials the peer first (best effort, 3 s limit)
  // and only then revokes. A second tap during that wait must not revoke twice.
  it('revokes once when Remove is pressed twice during a slow revoke', async () => {
    const engine = fakeEngine([iphone]);
    let finish: () => void = () => {};
    const revoke = jest.spyOn(engine, 'revokePairing').mockImplementation(
      () => new Promise<void>((resolve) => { finish = resolve; }),
    );
    mount(engine);
    fireEvent.press(await screen.findByTestId('remove-' + iphone.deviceId));
    fireEvent.press(screen.getByLabelText('confirm-remove'));
    fireEvent.press(screen.getByLabelText('confirm-remove'));
    await waitFor(() => expect(revoke).toHaveBeenCalledTimes(1));
    await act(async () => { finish(); });
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  // A pairing the user has not confirmed yet is pending (paired false). It is
  // not a paired device, so Settings must not offer to remove it. The pairing
  // screen owns its Reject button.
  it('does not list a pending pairing', async () => {
    mount(fakeEngine([iphone, { ...ipad, paired: false, presence: undefined }]));
    await screen.findByText('Darshit iPhone');
    expect(screen.queryByText('Living Room iPad')).toBeNull();
    expect(screen.getAllByText('Remove')).toHaveLength(1);
  });

  // Spec 6.5: the row works for an offline device, because devices() returns it.
  it('removes an offline device', async () => {
    const engine = fakeEngine([tablet]);
    const revoke = jest.spyOn(engine, 'revokePairing').mockResolvedValue();
    mount(engine);
    fireEvent.press(await screen.findByTestId('remove-' + tablet.deviceId));
    fireEvent.press(screen.getByLabelText('confirm-remove'));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith(tablet.deviceId));
  });

  // The fixture id comes from the first character of the name: 'D' is 0x44, so
  // the id is '44' repeated 16 times and its prefix is '44444444'.
  it('names a device with an empty name by its id prefix in the sheet', async () => {
    mount(fakeEngine([{ ...iphone, name: '' }]));
    fireEvent.press(await screen.findByTestId('remove-' + iphone.deviceId));
    expect(screen.getByText('Unpair Device 44444444?')).toBeTruthy();
  });

  it('shows the engine error and does not call the host hook when the revoke fails', async () => {
    const engine = fakeEngine([iphone]);
    jest.spyOn(engine, 'revokePairing').mockRejectedValue(new Error('database is locked'));
    const onUnpair = jest.fn();
    mount(engine, onUnpair);
    fireEvent.press(await screen.findByTestId('remove-' + iphone.deviceId));
    fireEvent.press(screen.getByLabelText('confirm-remove'));
    // An error needs the user to act, so it stays an inline note. No toast.
    expect(await screen.findByText('database is locked')).toBeTruthy();
    expect(screen.getByTestId('paired-result')).toBeTruthy();
    expect(screen.queryByTestId('toast')).toBeNull();
    expect(onUnpair).not.toHaveBeenCalled();
  });

  it('refreshes when a pairing is revoked elsewhere', async () => {
    const engine = fakeEngine([iphone]);
    const devices = jest.spyOn(engine, 'devices');
    mount(engine);
    await screen.findByText('Darshit iPhone');
    devices.mockResolvedValue([]);
    act(() => {
      (engine as unknown as { __handlers: Set<(e: DaakEvent) => void> }).__handlers.forEach((h) =>
        h({ type: 'pairing.revoked', deviceId: iphone.deviceId }),
      );
    });
    expect(await screen.findByText('No devices paired')).toBeTruthy();
  });
});

