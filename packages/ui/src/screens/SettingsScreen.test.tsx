import React from 'react';
import { Text, View } from 'react-native';
import { render, screen, waitFor } from '@testing-library/react-native';
import { EngineProvider } from '../EngineContext';
import { fakeEngine } from '../testing/fakeEngine';
import { SettingsScreen } from './SettingsScreen';

// The background-sync affordance is a SLOT, not a hard import. packages/ui
// depends on @daak/core and nothing else: requestBatteryExemption is a
// TurboModule call that lives in @daak/platform, and importing that here would
// invert the dependency direction (platform -> core, never the reverse) and
// pull a getEnforcing into every ui test. So the app injects the control and
// this test only proves the slot renders when supplied.
describe('SettingsScreen background-sync slot', () => {
  it('renders an injected control', () => {
    render(
      <EngineProvider engine={fakeEngine()}>
        <SettingsScreen background={<Text>allow-bg</Text>} />
      </EngineProvider>,
    );
    expect(screen.getByText('allow-bg')).toBeTruthy();
  });

  // The default has to render a working screen: desktop and any future shell
  // that passes nothing must not crash on an absent slot.
  it('renders without one', () => {
    render(
      <EngineProvider engine={fakeEngine()}>
        <SettingsScreen />
      </EngineProvider>,
    );
    expect(screen.getByText('Save name')).toBeTruthy();
  });
});

// R57: the collision prefix is a LAN artifact, not the name the user typed.
// Engine::self_profile reports the RESOLVED name -- "Rustic Otter . D2Dp" for a
// device the user named "D2Dp" on a LAN that already holds "D2Dp" -- and the
// screen read that field, so the box showed a name nobody typed. The screen
// must show the BASE name, which is what the settings file holds and what
// setDisplayName takes back.
describe('SettingsScreen shows the name the user typed', () => {
  const nameBox = () => screen.getByPlaceholderText('Display name');

  it('shows the base name when the engine resolved a collision prefix', async () => {
    const engine = fakeEngine();
    engine.selfProfile = async () => ({
      name: 'Rustic Otter . D2Dp',
      baseName: 'D2Dp',
      deviceId: 'dd'.repeat(16),
    });
    render(
      <EngineProvider engine={engine}>
        <SettingsScreen />
      </EngineProvider>,
    );
    await waitFor(() => expect(nameBox().props.value).toBe('D2Dp'));
  });

  // The other half of the same ruling: a name with no collision must come
  // through UNCHANGED. A screen that stripped a suffix would fail here.
  it('shows a plain name unchanged', async () => {
    const engine = fakeEngine();
    engine.selfProfile = async () => ({
      name: 'Pixel 9',
      baseName: 'Pixel 9',
      deviceId: 'dd'.repeat(16),
    });
    render(
      <EngineProvider engine={engine}>
        <SettingsScreen />
      </EngineProvider>,
    );
    await waitFor(() => expect(nameBox().props.value).toBe('Pixel 9'));
  });
});
