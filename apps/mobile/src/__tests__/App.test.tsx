import React from 'react';
import { render, screen } from '@testing-library/react-native';
import App from '../App';

describe('App', () => {
  it('boots and renders the tab shell', () => {
    render(<App />);
    expect(screen.getByText('dashboard')).toBeTruthy();
  });
});
