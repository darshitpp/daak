import React from 'react';
import { Text, View } from 'react-native';
import { render, screen } from '@testing-library/react-native';
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
