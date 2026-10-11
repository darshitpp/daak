import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { BackgroundHint } from './BackgroundHint';

describe('BackgroundHint', () => {
  // R44: the default copy must be true on iOS AND on Android, because
  // packages/ui has no platform branch. A default that names one platform
  // prints a falsehood on the other one. The host app passes its own
  // platform-specific sentence through the `body` prop instead.
  it('default body names no platform', () => {
    render(<BackgroundHint />);
    const body = screen.getByText(/Background transfers run while Daak is open/);
    expect(body).toBeTruthy();
    expect(body).not.toHaveTextContent('iOS');
    expect(body).not.toHaveTextContent('Android');
  });

  it('renders a caller-supplied body instead of the default', () => {
    render(<BackgroundHint body="Android decides when background sync runs." />);
    expect(screen.getByText('Android decides when background sync runs.')).toBeTruthy();
    expect(screen.queryByText(/Background transfers run while Daak is open/)).toBeNull();
  });

  it('renders the title', () => {
    render(<BackgroundHint />);
    expect(screen.getByText('It needs Daak open to sync now')).toBeTruthy();
  });

  // R128 (no dead button): the plan wires onOpen to engine.backgroundWake(),
  // which does not exist until Phase 7 Task 3 (R61). A Pressable with no real
  // action is a control wired to nothing, so the hint is copy-only unless a
  // caller can actually do something.
  it('renders no pressable when no action is passed', () => {
    render(<BackgroundHint />);
    expect(screen.queryByTestId('open-daak')).toBeNull();
  });

  it('fires the action when one is passed', () => {
    const onOpen = jest.fn();
    render(<BackgroundHint onOpen={onOpen} />);
    fireEvent.press(screen.getByTestId('open-daak'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
