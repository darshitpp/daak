import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ToastProvider } from '../../components/Toast';
import { ArrivalSection } from './ArrivalSection';
import type { SettingsHost } from './host';

const BLOCKED =
  "If notifications for Daak are blocked in your system settings, this switch can't turn alerts on. Allow notifications for Daak there, then try again.";

function host(over: Partial<SettingsHost> = {}, initial = { arrival: true }) {
  const save = jest.fn(async () => {});
  const h: SettingsHost = {
    notifyPrefs: { load: jest.fn(async () => initial), save },
    ...over,
  };
  return { h, save };
}
const state = (label: string) => screen.getByLabelText(label).props.accessibilityState;

describe('ArrivalSection', () => {
  it('shows one switch, on by default, with the design hint', async () => {
    const { h } = host();
    render(<ArrivalSection host={h} deviceNoun="Mac" />);
    expect(await screen.findByText('Shows a message on this Mac.')).toBeTruthy();
    expect(state('Tell me when a file arrives')).toMatchObject({ checked: true });
    // Design v2 removed the sound switch.
    expect(screen.queryByText('Play a sound too')).toBeNull();
    expect(screen.queryByText('Optional chime.')).toBeNull();
    expect(screen.queryByText(BLOCKED)).toBeNull();
  });

  it('is hidden when the host has no preference store', () => {
    render(<ArrivalSection host={{}} />);
    expect(screen.queryByText('Arrival messages')).toBeNull();
  });

  it('saves the arrival switch and toasts the design words', async () => {
    const { h, save } = host();
    render(<ToastProvider><ArrivalSection host={h} /></ToastProvider>);
    await screen.findByText('Shows a message on this device.');
    fireEvent.press(screen.getByLabelText('Tell me when a file arrives'));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ arrival: false }));
    expect(state('Tell me when a file arrives')).toMatchObject({ checked: false });
    // Design `data-off` of `#set-alerts`.
    expect(await screen.findByText('Arrival messages off')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Tell me when a file arrives'));
    // Design `data-on`. The new toast replaces the old one.
    expect(await screen.findByText('Arrival messages on')).toBeTruthy();
    expect(screen.queryByText('Arrival messages off')).toBeNull();
  });

  it('shows no toast when the host has no provider', async () => {
    const { h, save } = host();
    render(<ArrivalSection host={h} />);
    await screen.findByText('Shows a message on this device.');
    fireEvent.press(screen.getByLabelText('Tell me when a file arrives'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  // D8 and design v2: the OS grant is a second fact. The switch reads off, the
  // design hint says why, and a press opens system settings instead of
  // changing the preference.
  it('reads off, shows the blocked hint, and opens system settings when the OS grant is missing', async () => {
    const openSettings = jest.fn();
    const { h, save } = host({ osAlerts: { granted: async () => false, openSettings } });
    render(<ArrivalSection host={h} deviceNoun="phone" />);
    expect(await screen.findByText(BLOCKED)).toBeTruthy();
    expect(screen.getByText('Shows a message on this phone.')).toBeTruthy();
    expect(state('Tell me when a file arrives')).toMatchObject({ checked: false });
    fireEvent.press(screen.getByLabelText('Tell me when a file arrives'));
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  it('shows the blocked hint and no press handler when the host cannot open system settings', async () => {
    const { h, save } = host({ osAlerts: { granted: async () => false } });
    render(<ArrivalSection host={h} />);
    expect(await screen.findByText(BLOCKED)).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Tell me when a file arrives'));
    expect(save).not.toHaveBeenCalled();
  });

  it('treats an unasked grant as not denied', async () => {
    const { h } = host({ osAlerts: { granted: async () => undefined } });
    render(<ArrivalSection host={h} />);
    await screen.findByText('Shows a message on this device.');
    expect(state('Tell me when a file arrives')).toMatchObject({ checked: true });
    expect(screen.queryByText(BLOCKED)).toBeNull();
  });

  // A parent that builds a new host object on each render must not re-run the
  // load. A late answer would overwrite a switch that the user just flipped.
  it('does not load again when the parent re-renders with a new but equal host object', async () => {
    const load = jest.fn(async () => ({ arrival: true }));
    const save = jest.fn(async () => {});
    const granted = jest.fn(async (): Promise<boolean | undefined> => true);
    const make = (): SettingsHost => ({ notifyPrefs: { load, save }, osAlerts: { granted } });
    const { rerender } = render(<ArrivalSection host={make()} />);
    await screen.findByText('Shows a message on this device.');
    rerender(<ArrivalSection host={make()} />);
    rerender(<ArrivalSection host={make()} />);
    await act(async () => {});
    expect(load).toHaveBeenCalledTimes(1);
    expect(granted).toHaveBeenCalledTimes(1);
  });

  it('restores the switch and shows the error when the save fails', async () => {
    const save = jest.fn(async () => { throw new Error('disk full'); });
    render(
      <ToastProvider>
        <ArrivalSection host={{ notifyPrefs: { load: async () => ({ arrival: true }), save } }} />
      </ToastProvider>,
    );
    await screen.findByText('Shows a message on this device.');
    fireEvent.press(screen.getByLabelText('Tell me when a file arrives'));
    expect(await screen.findByText('disk full')).toBeTruthy();
    expect(state('Tell me when a file arrives')).toMatchObject({ checked: true });
    // A failed save is an error note. It is not a toast.
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  it('keeps the default when the load fails', async () => {
    const load = jest.fn(async () => { throw new Error('store unreadable'); });
    render(<ArrivalSection host={{ notifyPrefs: { load, save: async () => {} } }} />);
    await waitFor(() => expect(load).toHaveBeenCalled());
    expect(state('Tell me when a file arrives')).toMatchObject({ checked: true });
  });
});

