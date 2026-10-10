import React from 'react';
import { StyleSheet } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { Wordmark } from './Wordmark';
import { Wordmark as FromDs } from './ds';

/**
 * The lockup from the design: the mark, then the letters "aak". The design
 * sizes it with one number, --wm-size (17, 22 or 19 px). The mark is 1.024 and
 * 1.1 times that size. These cases pin the lockup, not the pixels of the PNG.
 */
describe('Wordmark', () => {
  it('shows the mark and the letters aak, and not a letter D', () => {
    render(<Wordmark />);
    expect(screen.getByLabelText('Daak')).toBeTruthy();
    expect(screen.getByTestId('wordmark-mark')).toBeTruthy();
    expect(screen.getByText('aak')).toBeTruthy();
    expect(screen.queryByText('D')).toBeNull();
  });

  it('is 22 px by default, the large size of the design', () => {
    render(<Wordmark />);
    const mark = StyleSheet.flatten(screen.getByTestId('wordmark-mark').props.style);
    expect(mark.width).toBeCloseTo(22 * 1.024, 5);
    expect(mark.height).toBeCloseTo(22 * 1.1, 5);
    expect(StyleSheet.flatten(screen.getByText('aak').props.style).fontSize).toBe(22);
  });

  it('is 17 px for sm', () => {
    render(<Wordmark size="sm" />);
    const mark = StyleSheet.flatten(screen.getByTestId('wordmark-mark').props.style);
    expect(mark.height).toBeCloseTo(17 * 1.1, 5);
    expect(StyleSheet.flatten(screen.getByText('aak').props.style).fontSize).toBe(17);
  });

  it('scales the mark and the text together for a number', () => {
    render(<Wordmark size={19} />);
    const mark = StyleSheet.flatten(screen.getByTestId('wordmark-mark').props.style);
    const text = StyleSheet.flatten(screen.getByText('aak').props.style);
    expect(mark.width).toBeCloseTo(19 * 1.024, 5);
    expect(mark.height).toBeCloseTo(19 * 1.1, 5);
    expect(text.fontSize).toBe(19);
    expect(text.letterSpacing).toBeCloseTo(-0.02 * 19, 5);
  });

  it('is the same component that ds.tsx exports', () => {
    expect(FromDs).toBe(Wordmark);
  });
});

