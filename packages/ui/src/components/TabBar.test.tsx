import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Sidebar, TabBar } from './TabBar';

const GONE = ['Send', 'Inbox', 'Transfers'];

// On iOS a Pressable that only sets accessibilityRole="tab" collapses its
// children: the label never reaches the accessibility tree. A real name on a
// `button` puts the label back.
it('gives both phone tabs an accessible name and the button role', () => {
  render(<TabBar tab="devices" onChange={() => {}} />);
  for (const label of ['Devices', 'Settings']) {
    const tab = screen.getByLabelText(label);
    expect(tab.props.accessibilityRole).toBe('button');
  }
});

it('has no Send, Inbox, or Transfers tab', () => {
  render(<TabBar tab="devices" onChange={() => {}} />);
  for (const label of GONE) expect(screen.queryByLabelText(label)).toBeNull();
  for (const id of ['tab-send', 'tab-inbox', 'tab-history', 'tab-transfers']) expect(screen.queryByTestId(id)).toBeNull();
});

it('marks only the open tab as selected', () => {
  render(<TabBar tab="settings" onChange={() => {}} />);
  expect(screen.getByLabelText('Settings').props.accessibilityState).toMatchObject({ selected: true });
  expect(screen.getByLabelText('Devices').props.accessibilityState).toMatchObject({ selected: false });
});

it('gives both destinations a stable testID', () => {
  render(<TabBar tab="devices" onChange={() => {}} />);
  for (const id of ['tab-devices', 'tab-settings']) expect(screen.getByTestId(id)).toBeTruthy();
});

it('reports the tab that was pressed', () => {
  const onChange = jest.fn();
  render(<TabBar tab="devices" onChange={onChange} />);
  fireEvent.press(screen.getByTestId('tab-settings'));
  expect(onChange).toHaveBeenCalledWith('settings');
});

// The macOS window shows the same two destinations in a 248px sidebar on every
// route (design: macos.html, `.sidebar`). The window has no header segments.
describe('the window sidebar', () => {
  it('draws the wordmark, the two destinations, and the version footer', () => {
    render(<Sidebar active="devices" onChange={() => {}} version="Version 0.4.2 (build 1180)" />);
    expect(screen.getByTestId('window-sidebar')).toBeTruthy();
    expect(screen.getByTestId('wordmark')).toBeTruthy();
    for (const label of ['Devices', 'Settings']) {
      expect(screen.getByLabelText(label).props.accessibilityRole).toBe('button');
    }
    expect(screen.getByText('Version 0.4.2 (build 1180)')).toBeTruthy();
    expect(screen.queryByTestId('tab-devices')).toBeNull();
  });

  it('marks the active destination and reports a press', () => {
    const onChange = jest.fn();
    render(<Sidebar active="settings" onChange={onChange} version="Version 1.0 (build 7)" />);
    expect(screen.getByLabelText('Settings').props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.getByLabelText('Devices').props.accessibilityState).toMatchObject({ selected: false });
    fireEvent.press(screen.getByTestId('side-devices'));
    expect(onChange).toHaveBeenCalledWith('devices');
  });

  it('draws no version footer when the host has none', () => {
    render(<Sidebar active="devices" onChange={() => {}} />);
    expect(screen.queryByText(/Version /)).toBeNull();
  });

  it('keeps each destination at 44 points or more', () => {
    render(<Sidebar active="devices" onChange={() => {}} version="Version 1.0 (build 7)" />);
    const style = screen.getByTestId('side-devices').props.style;
    const flat = Array.isArray(style) ? Object.assign({}, ...style.flat().filter(Boolean)) : style;
    expect(flat.minHeight).toBeGreaterThanOrEqual(44);
  });
});

// Design: the tab bar uses the SVG icons, not glyphs.
it('draws the design icon for each phone tab, and no glyph', () => {
  render(<TabBar tab="devices" onChange={() => {}} />);
  expect(screen.getByTestId('tab-icon-devices')).toBeTruthy();
  expect(screen.getByTestId('tab-icon-settings')).toBeTruthy();
  expect(screen.queryByText('▣')).toBeNull();
  expect(screen.queryByText('⚙')).toBeNull();
});

