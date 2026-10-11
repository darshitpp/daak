import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { TabBar } from './TabBar';

const GONE = ['Send', 'Inbox', 'Transfers'];

// On iOS a Pressable that only sets accessibilityRole="tab" collapses its
// children: the label never reaches the accessibility tree. A real name on a
// `button` puts the label back.
it('gives both phone tabs an accessible name and the button role', () => {
  render(<TabBar tab="devices" onChange={() => {}} layout="mobile" />);
  for (const label of ['Devices', 'Settings']) {
    const tab = screen.getByLabelText(label);
    expect(tab.props.accessibilityRole).toBe('button');
  }
});

it('has no Send, Inbox, or Transfers tab', () => {
  render(<TabBar tab="devices" onChange={() => {}} layout="mobile" />);
  for (const label of GONE) expect(screen.queryByLabelText(label)).toBeNull();
  for (const id of ['tab-send', 'tab-inbox', 'tab-history', 'tab-transfers']) expect(screen.queryByTestId(id)).toBeNull();
});

it('marks only the open tab as selected', () => {
  render(<TabBar tab="settings" onChange={() => {}} layout="mobile" />);
  expect(screen.getByLabelText('Settings').props.accessibilityState).toMatchObject({ selected: true });
  expect(screen.getByLabelText('Devices').props.accessibilityState).toMatchObject({ selected: false });
});

it('gives both destinations a stable testID', () => {
  render(<TabBar tab="devices" onChange={() => {}} layout="mobile" />);
  for (const id of ['tab-devices', 'tab-settings']) expect(screen.getByTestId(id)).toBeTruthy();
});

it('reports the tab that was pressed', () => {
  const onChange = jest.fn();
  render(<TabBar tab="devices" onChange={onChange} layout="mobile" />);
  fireEvent.press(screen.getByTestId('tab-settings'));
  expect(onChange).toHaveBeenCalledWith('settings');
});

// The macOS window shows the same two destinations as a segmented control in
// its header (design: macos.html), with the host's title and version line.
it('draws the window header with a title, two segments, and a trailing line', () => {
  const onChange = jest.fn();
  render(<TabBar tab="devices" onChange={onChange} layout="desktop" title="Daak for Mac" trailing="Version 1.0 (build 7)" />);
  expect(screen.getByText('Daak for Mac')).toBeTruthy();
  expect(screen.getByText('Version 1.0 (build 7)')).toBeTruthy();
  for (const label of ['Devices', 'Settings']) expect(screen.getByLabelText(label).props.accessibilityRole).toBe('button');
  fireEvent.press(screen.getByTestId('tab-settings'));
  expect(onChange).toHaveBeenCalledWith('settings');
});

// Plan P5 draws the mark. This plan places it: the header holds the Wordmark,
// and the phone bar does not.
it('shows the Wordmark in the window header and not in the phone bar', () => {
  const { rerender } = render(<TabBar tab="devices" onChange={() => {}} layout="desktop" title="Daak for Mac" />);
  expect(screen.getByTestId('window-wordmark')).toBeTruthy();
  rerender(<TabBar tab="devices" onChange={() => {}} layout="mobile" />);
  expect(screen.queryByTestId('window-wordmark')).toBeNull();
});

it('keeps each tab target at 44 points or more', () => {
  render(<TabBar tab="devices" onChange={() => {}} layout="desktop" title="Daak" />);
  const style = screen.getByTestId('tab-devices').props.style;
  const flat = Array.isArray(style) ? Object.assign({}, ...style.flat().filter(Boolean)) : style;
  expect(flat.minHeight).toBeGreaterThanOrEqual(44);
});

// Design: the tab bar uses the SVG icons, not glyphs.
it('draws the design icon for each phone tab, and no glyph', () => {
  render(<TabBar tab="devices" onChange={() => {}} layout="mobile" />);
  expect(screen.getByTestId('tab-icon-devices')).toBeTruthy();
  expect(screen.getByTestId('tab-icon-settings')).toBeTruthy();
  expect(screen.queryByText('▣')).toBeNull();
  expect(screen.queryByText('⚙')).toBeNull();
});

