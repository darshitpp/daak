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

it('renders with no slot supplied', () => {
  render(
    <EngineProvider engine={fakeEngine()}>
      <AppShell />
    </EngineProvider>,
  );
  expect(screen.getByText('dashboard')).toBeTruthy();
});
