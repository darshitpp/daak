import React from 'react';
import { render, screen } from '@testing-library/react-native';
import App from '../App';

// The real bootstrap reaches for the `Daak` TurboModule, which does not exist
// under Jest. Swap in the in-memory engine; that is the whole point of a smoke
// test -- the shell renders, the Rust edge is not exercised here.
jest.mock('../bootstrap', () => ({
  engine: jest.requireActual('@daak/ui').fakeEngine(),
  startEngine: async () => {},
  drainInbound: jest.fn(async () => {}),
  sendIntentItems: jest.fn(async () => {}),
  postReceiveNotifications: jest.fn(async () => true),
}));

const { drainInbound, sendIntentItems, engine } = jest.requireMock('../bootstrap');

beforeEach(() => jest.clearAllMocks());

describe('App', () => {
  it('boots and renders the tab shell', () => {
    render(<App />);
    expect(screen.getByText('dashboard')).toBeTruthy();
  });

  it('does NOT drain the staged share inbox on mount', () => {
    render(<App />);
    // R22 regression guard. App MUST NOT drain on mount. consumePendingShare is
    // all-or-nothing natively: draining here would delete the batch that names
    // a shared text/file item while its bytes sit unreferenced, i.e. silent
    // data loss on the inbound path. Nothing consumes those items yet (Task 11
    // owns the composer route), so the staged batch is the correct resting
    // state. Task 7/9 own the intent-send arm. Re-adding the effect fails here.
    expect(drainInbound).not.toHaveBeenCalled();
  });

  it('leaves the engine untouched on mount', () => {
    const send = jest.spyOn(engine, 'send');
    render(<App />);
    expect(send).not.toHaveBeenCalled();
    expect(sendIntentItems).not.toHaveBeenCalled();
  });
});
