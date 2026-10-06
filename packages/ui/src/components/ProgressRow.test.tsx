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

  // R42h: a TEXT item is zero bytes, so the byte ratio is 0/0 and the row read
  // "done" beside a 0% bar. The state decides before the ratio does.
  it('reports a done zero-byte transfer as complete', () => {
    render(<ProgressRow name="hello" bytesDone={0} bytesTotal={0} state="done" />);
    expect(screen.getByText('100%')).toBeTruthy();
  });

  // The exception: `canceled` is terminal but NOT complete, so it keeps its
  // real ratio rather than claiming the bytes were sent.
  it('does not report a canceled transfer as complete', () => {
    render(<ProgressRow name="hello" bytesDone={0} bytesTotal={0} state="canceled" />);
    expect(screen.getByText('0%')).toBeTruthy();
  });
});
