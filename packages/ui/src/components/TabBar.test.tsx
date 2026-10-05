import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { TabBar } from './TabBar';

// On iOS a Pressable that only sets accessibilityRole="tab" COLLAPSES its
// children: the label text never reaches the accessibility tree, so VoiceOver
// announces "tab" with no name and no automation surface can find the tab.
// Android was unaffected, which is why no test caught it. A real name on the
// pressable is what puts the label back.
it('gives every tab an accessible name', () => {
  render(<TabBar tab="send" onChange={() => {}} layout="mobile" />);
  for (const label of ['Send', 'Devices', 'Inbox', 'Transfers', 'Settings']) {
    const tab = screen.getByLabelText(label);
    expect(tab).toBeTruthy();
    expect(tab.props.accessibilityRole).toBe('button');
  }
});

// The selected state is what tells a screen reader which destination is open.
// It is asserted separately so a name that is right but a selected flag that is
// wrong cannot pass.
it('marks only the open tab as selected', () => {
  // The Inbox DESTINATION is the `history` slot. Writing "inbox" here would
  // match no tab at all and the assertion would pass for the wrong reason.
  render(<TabBar tab="history" onChange={() => {}} layout="mobile" />);
  expect(screen.getByLabelText('Inbox').props.accessibilityState).toMatchObject({ selected: true });
  expect(screen.getByLabelText('Send').props.accessibilityState).toMatchObject({ selected: false });
});

// The desktop rail is the same five destinations. A name on the phone and no
// name on the desktop is the split this file exists to prevent.
it('gives every desktop rail item an accessible name', () => {
  render(<TabBar tab="devices" onChange={() => {}} layout="desktop" />);
  for (const label of ['Send', 'Devices', 'Inbox', 'Transfers', 'Settings']) {
    expect(screen.getByLabelText(label)).toBeTruthy();
  }
});

// React Native maps `tab` to UIAccessibilityTraitNone on iOS (RCTViewManager.m),
// the same as `none`. A trait of None is not an accessibility element, so a tab
// with that role is invisible to VoiceOver and to XCUITest even with a label.
// `button` is the role iOS actually implements, and a tab IS a control the user
// activates, so the selected state still carries the tab meaning. This test
// pins the role that iOS honours.
it('gives each tab a role iOS actually implements as an element', () => {
  render(<TabBar tab="send" onChange={() => {}} layout="mobile" />);
  for (const label of ['Send', 'Devices', 'Inbox', 'Transfers', 'Settings']) {
    expect(screen.getByLabelText(label).props.accessibilityRole).toBe('button');
  }
});

// Every other control in this package carries a testID. The five destinations
// did not, so no test and no automation surface could address one, and a tab
// that cannot be addressed cannot be proven to work.
it('gives every destination a stable testID', () => {
  render(<TabBar tab="send" onChange={() => {}} layout="mobile" />);
  for (const id of ['tab-send', 'tab-devices', 'tab-inbox', 'tab-transfers', 'tab-settings']) {
    expect(screen.getByTestId(id)).toBeTruthy();
  }
});
