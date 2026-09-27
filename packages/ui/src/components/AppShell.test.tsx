import React from 'react';
import { Text } from 'react-native';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { EngineProvider } from '../EngineContext';
import { fakeEngine } from '../testing/fakeEngine';
import { AppShell } from './AppShell';

// The background control has to be REACHABLE, not merely renderable: an app
// that injects it into SettingsScreen but forgets to thread it through AppShell
// shows a Settings screen that silently has no affordance on it. This drives
// the real tab bar, so the whole path is covered.
it('threads a background slot through to the Settings tab', () => {
  render(
    <EngineProvider engine={fakeEngine()}>
      <AppShell background={<Text>allow-bg</Text>} />
    </EngineProvider>,
  );
  // TabBar exposes each tab as Pressable > Text, not as an accessibilityLabel,
  // so the press target is the text node itself.
  fireEvent.press(screen.getByText('settings'));
  expect(screen.getByText('allow-bg')).toBeTruthy();
});

// The pair flow is APP-side (R100), so the shell test proves the slot is
// threaded with a stub; apps/mobile/src/__tests__/pairingFlow.test.tsx proves
// the real wrapper behind it. Same split as the background slot.
it('threads a pair slot through to the Pair tab', () => {
  render(
    <EngineProvider engine={fakeEngine()}>
      <AppShell pair={<Text>pair-ui</Text>} />
    </EngineProvider>,
  );
  fireEvent.press(screen.getByText('pair'));
  expect(screen.getByText('pair-ui')).toBeTruthy();
});

it('renders with no slot supplied', () => {
  render(
    <EngineProvider engine={fakeEngine()}>
      <AppShell />
    </EngineProvider>,
  );
  expect(screen.getByText('dashboard')).toBeTruthy();
});

// I1: TransferProgressScreen had ZERO render sites, so every transfer.item row
// the engine really emits was invisible. This is a REACHABILITY pin, not a
// renderability one: it drives the real tab bar, so deleting either the
// 'transfers' entry in TabBar or the slot line in AppShell fails here. Same
// discipline as the pair slot above.
it('threads a transfers slot through to the Transfers tab', () => {
  render(
    <EngineProvider engine={fakeEngine()}>
      <AppShell transfers={<Text>transfers-ui</Text>} />
    </EngineProvider>,
  );
  fireEvent.press(screen.getByText('transfers'));
  expect(screen.getByText('transfers-ui')).toBeTruthy();
});

// M1: onSend used to be `() => {}` on Dashboard and Devices, so DeviceCard
// rendered a real Pressable wired to nothing. The shell now THREADS onSend to
// both device lists, and DeviceCard renders Send only when one is supplied.
it('threads onSend to the device lists, and no Send renders without one', async () => {
  const onSend = jest.fn();
  render(
    <EngineProvider engine={fakeEngine()}>
      <AppShell onSend={onSend} />
    </EngineProvider>,
  );
  const send = await screen.findByText('Send');
  fireEvent.press(send);
  expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ name: 'Pixel 9' }));
});

it('renders no Send button at all when the app supplies no onSend', async () => {
  render(
    <EngineProvider engine={fakeEngine()}>
      <AppShell />
    </EngineProvider>,
  );
  // A device card still lists the peer; only the dead affordance is gone.
  expect(await screen.findByText('Pixel 9')).toBeTruthy();
  expect(screen.queryByText('Send')).toBeNull();
});
