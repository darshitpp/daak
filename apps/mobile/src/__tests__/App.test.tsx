import React from 'react';
import { render, screen } from '@testing-library/react-native';
import App from '../App';

// The real bootstrap reaches for the `Daak` TurboModule, which does not exist
// under Jest. Swap in the in-memory engine; that is the whole point of a smoke
// test -- the shell renders, the Rust edge is not exercised here.
jest.mock('../bootstrap', () => ({ engine: jest.requireActual('@daak/ui').fakeEngine(), startEngine: async () => {} }));

describe('App', () => {
  it('boots and renders the tab shell', () => {
    render(<App />);
    expect(screen.getByText('dashboard')).toBeTruthy();
  });
});
