import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { ProgressRow } from './ProgressRow';

describe('ProgressRow', () => {
  it('shows a whole-number percentage and the transfer state', () => {
    render(<ProgressRow name="movie.mov" bytesDone={450} bytesTotal={1000} state="receiving" />);
    expect(screen.getByText('movie.mov')).toBeTruthy();
    expect(screen.getByText('45%')).toBeTruthy();
    expect(screen.getByText('receiving')).toBeTruthy();
  });

  it('never divides by zero on an empty payload', () => {
    render(<ProgressRow name="x" bytesDone={0} bytesTotal={0} state="pending" />);
    expect(screen.getByText('0%')).toBeTruthy();
  });
});
