import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { act, render, screen } from '@testing-library/react-native';
import { ToastProvider, useToast } from './Toast';
import { radius, spacing } from '../theme';

// The latest `show` that a child got from the hook.
let show: (message: string) => void = () => {};
function Capture() {
  show = useToast().show;
  return <Text>child</Text>;
}

const ping = (message: string) => act(() => show(message));

describe('Toast', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    show = () => {};
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders its children and no toast at first', () => {
    render(<ToastProvider><Capture /></ToastProvider>);
    expect(screen.getByText('child')).toBeTruthy();
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  it('shows the message in an alert pill with a polite live region', () => {
    render(<ToastProvider><Capture /></ToastProvider>);
    ping('Copied');
    expect(screen.getByTestId('toast-text')).toHaveTextContent('Copied');
    const pill = screen.getByTestId('toast');
    expect(pill.props.accessibilityRole).toBe('alert');
    expect(pill.props.accessibilityLiveRegion).toBe('polite');
  });

  it('hides the toast after 2600 ms and not before', () => {
    render(<ToastProvider><Capture /></ToastProvider>);
    ping('Copied');
    act(() => { jest.advanceTimersByTime(2599); });
    expect(screen.getByTestId('toast')).toBeTruthy();
    act(() => { jest.advanceTimersByTime(1); });
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  it('puts the toast at bottomOffset', () => {
    render(<ToastProvider bottomOffset={24}><Capture /></ToastProvider>);
    ping('Hi');
    // The wrapper carries its own test id: `.parent` of a host View returns the
    // pill's own composite in this version of the testing library.
    const wrap = screen.getByTestId('toast-wrap');
    expect(StyleSheet.flatten(wrap.props.style).bottom).toBe(24);
  });

  it('honors durationMs', () => {
    render(<ToastProvider durationMs={500}><Capture /></ToastProvider>);
    ping('Saved');
    act(() => { jest.advanceTimersByTime(500); });
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  it('replaces the toast on a second show and restarts the timer', () => {
    render(<ToastProvider><Capture /></ToastProvider>);
    ping('First');
    act(() => { jest.advanceTimersByTime(2000); });
    ping('Second');
    expect(screen.queryByText('First')).toBeNull();
    expect(screen.getByTestId('toast-text')).toHaveTextContent('Second');
    // 2000 ms after the second show. The first timer would have fired by now.
    act(() => { jest.advanceTimersByTime(2000); });
    expect(screen.getByTestId('toast-text')).toHaveTextContent('Second');
    act(() => { jest.advanceTimersByTime(600); });
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  it('clears its timer on unmount', () => {
    const { unmount } = render(<ToastProvider><Capture /></ToastProvider>);
    ping('Copied');
    expect(jest.getTimerCount()).toBe(1);
    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('gives a no-op show outside a provider and does not throw', () => {
    render(<Capture />);
    expect(() => ping('Copied')).not.toThrow();
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  // Design index.html .toast: a full-width bar (left and right 16, radius-sm,
  // padding 12). macos.html shows a pill.
  it('draws a full-width bar in the bar layout and a pill by default', () => {
    const { unmount } = render(<ToastProvider layout="bar"><Capture /></ToastProvider>);
    ping('Saved');
    const bar = StyleSheet.flatten(screen.getByTestId('toast').props.style);
    expect(bar.borderRadius).toBe(radius.sm);
    expect(bar.padding).toBe(spacing.md);
    expect(StyleSheet.flatten(screen.getByTestId('toast-wrap').props.style).paddingHorizontal).toBe(spacing.lg);
    unmount();
    render(<ToastProvider><Capture /></ToastProvider>);
    ping('Saved');
    expect(StyleSheet.flatten(screen.getByTestId('toast').props.style).borderRadius).toBe(radius.pill);
  });
});

