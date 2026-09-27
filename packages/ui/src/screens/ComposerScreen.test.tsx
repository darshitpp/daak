import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { EngineProvider } from '../EngineContext';
import { ComposerScreen } from './ComposerScreen';
import { fakeEngine } from '../testing/fakeEngine';

describe('ComposerScreen', () => {
  it('disables send until text or a file is present', () => {
    render(
      <EngineProvider engine={fakeEngine()}>
        <ComposerScreen />
      </EngineProvider>,
    );
    expect(screen.getByLabelText('send')).toBeDisabled();
  });
});
