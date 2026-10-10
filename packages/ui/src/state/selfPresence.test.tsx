import React from 'react';
import { Text } from 'react-native';
import { act, render, screen } from '@testing-library/react-native';
import { getSelfPresence, setSelfPresenceLocal, useSelfPresence } from './selfPresence';

function Probe() {
  return <Text testID="p">{useSelfPresence()}</Text>;
}
afterEach(() => act(() => setSelfPresenceLocal('online')));

it('starts online, like the engine', () => {
  expect(getSelfPresence()).toBe('online');
});

it('updates every reader when the value changes, and not for the same value', () => {
  render(<Probe />);
  expect(screen.getByTestId('p').props.children).toBe('online');
  act(() => setSelfPresenceLocal('away'));
  expect(screen.getByTestId('p').props.children).toBe('away');
  expect(getSelfPresence()).toBe('away');
});

