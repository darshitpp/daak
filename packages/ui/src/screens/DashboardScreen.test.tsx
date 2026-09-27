import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { EngineProvider } from '../EngineContext';
import { DashboardScreen } from './DashboardScreen';
import { fakeEngine } from '../testing/fakeEngine';

describe('DashboardScreen', () => {
  it('renders online devices provided by the injected engine', async () => {
    render(
      <EngineProvider engine={fakeEngine()}>
        <DashboardScreen />
      </EngineProvider>,
    );
    expect(await screen.findByText('Pixel 9')).toBeTruthy();
  });
});
