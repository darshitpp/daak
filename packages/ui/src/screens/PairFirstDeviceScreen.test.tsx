import React from 'react';
import { Text } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { PairFirstDeviceScreen } from './PairFirstDeviceScreen';

describe('PairFirstDeviceScreen', () => {
  it('is a frame: the appbar title and the host flow, and no step counter', () => {
    render(
      <PairFirstDeviceScreen>
        <Text>flow</Text>
      </PairFirstDeviceScreen>,
    );
    expect(screen.getByText('Pair your first device')).toBeTruthy();
    expect(screen.getByText('flow')).toBeTruthy();
    expect(screen.queryByText('Step 3 of 3')).toBeNull();
  });

  it('goes back', () => {
    const back = jest.fn();
    render(
      <PairFirstDeviceScreen onBack={back}>
        <Text>flow</Text>
      </PairFirstDeviceScreen>,
    );
    fireEvent.press(screen.getByTestId('onb-back'));
    expect(back).toHaveBeenCalledTimes(1);
  });
});

