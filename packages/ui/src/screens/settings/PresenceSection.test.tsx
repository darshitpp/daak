import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { EngineProvider } from '../../EngineContext';
import { fakeEngine } from '../../testing/fakeEngine';
import { ToastProvider } from '../../components/Toast';
import { getSelfPresence, setSelfPresenceLocal } from '../../state/selfPresence';
import { PresenceSection } from './PresenceSection';

afterEach(() => act(() => setSelfPresenceLocal('online')));
const state = () => screen.getByLabelText('Are you using this device right now?').props.accessibilityState;
const mount = (engine = fakeEngine([]), noun: 'phone' | 'Mac' = 'phone') =>
  render(
    <EngineProvider engine={engine}>
      <ToastProvider>
        <PresenceSection deviceNoun={noun} />
      </ToastProvider>
    </EngineProvider>,
  );

it('starts on, with the design words', () => {
  mount();
  expect(screen.getByText('Are you using this device right now?')).toBeTruthy();
  expect(screen.getByText('Other devices see this phone as On this network.')).toBeTruthy();
  expect(state()).toMatchObject({ checked: true });
});

it('turns off to Away and tells the engine', async () => {
  const engine = fakeEngine([]);
  const set = jest.spyOn(engine, 'setPresence').mockResolvedValue();
  mount(engine, 'Mac');
  fireEvent.press(screen.getByLabelText('Are you using this device right now?'));
  expect(screen.getByText('Other devices see this Mac as Away.')).toBeTruthy();
  expect(set).toHaveBeenCalledWith('away');
  expect(getSelfPresence()).toBe('away');
  // The design toast `data-off` of `#set-presence`.
  expect(await screen.findByText('Other devices see you as Away')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Are you using this device right now?'));
  await waitFor(() => expect(set).toHaveBeenLastCalledWith('online'));
  expect(await screen.findByText('Other devices see you as On this network')).toBeTruthy();
});

it('restores the value and shows the error when the engine refuses', async () => {
  const engine = fakeEngine([]);
  jest.spyOn(engine, 'setPresence').mockRejectedValue(new Error('engine not started'));
  mount(engine);
  fireEvent.press(screen.getByLabelText('Are you using this device right now?'));
  expect(await screen.findByText('engine not started')).toBeTruthy();
  expect(getSelfPresence()).toBe('online');
  expect(state()).toMatchObject({ checked: true });
  // A refused change is an error note. It is not a toast.
  expect(screen.queryByTestId('toast')).toBeNull();
});

