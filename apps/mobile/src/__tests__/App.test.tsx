import React from 'react';
import { render, screen } from '@testing-library/react-native';
import App from '../App';

describe('App', () => {
  it('boots and renders the app title', () => {
    render(<App />);
    expect(screen.getByText('Daak')).toBeTruthy();
  });
});
