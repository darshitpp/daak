import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { BackgroundHint } from './BackgroundHint';

describe('BackgroundHint', () => {
  it('states the copy honestly: iOS decides when background sync runs', () => {
    render(<BackgroundHint />);
    expect(screen.getByText(/iOS decides when background sync runs/)).toBeTruthy();
  });

  // R128 (no dead button): the plan wires onOpen to engine.backgroundWake(),
  // which does not exist until Phase 7 Task 3 (R61). A Pressable with no real
  // action is a control wired to nothing, so the hint is copy-only unless a
  // caller can actually do something.
  it('renders no pressable when no action is passed', () => {
    render(<BackgroundHint />);
    expect(screen.queryByLabelText('open-daak')).toBeNull();
  });

  it('fires the action when one is passed', () => {
    const onOpen = jest.fn();
    render(<BackgroundHint onOpen={onOpen} />);
    fireEvent.press(screen.getByLabelText('open-daak'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
