import React from 'react';
import { Linking } from 'react-native';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { AboutSection } from './AboutSection';
import { colors, type, ui } from '../../theme';
import { ABOUT_LINKS, RELEASES_URL } from '../about-links';

afterEach(() => jest.restoreAllMocks());

it('shows the four facts', () => {
  render(<AboutSection />);
  fireEvent.press(screen.getByTestId('about-toggle'));
  expect(screen.getByText('This Wi-Fi only')).toBeTruthy();
  expect(screen.getByText('No account, none')).toBeTruthy();
  expect(screen.getByText('On your devices')).toBeTruthy();
});

// appInfo is async (P2). The row shows only after the host answers.
it('shows the real version and build after the host answers, and no row without a host', async () => {
  const { unmount } = render(<AboutSection appInfo={async () => ({ version: '0.4.2', build: '1180' })} />);
  fireEvent.press(screen.getByTestId('about-toggle'));
  expect(screen.queryByText(/^Version /)).toBeNull();
  expect(await screen.findByText('Version 0.4.2 (build 1180)')).toBeTruthy();
  unmount();
  render(<AboutSection />);
  fireEvent.press(screen.getByTestId('about-toggle'));
  await act(async () => {});
  expect(screen.getByTestId('about-facts')).toBeTruthy();
  expect(screen.queryByText(/^Version /)).toBeNull();
});

it('hides the version row when the host rejects or reports unknown', async () => {
  const appInfo = jest.fn().mockRejectedValueOnce(new Error('no native module'));
  const { unmount } = render(<AboutSection appInfo={appInfo} />);
  fireEvent.press(screen.getByTestId('about-toggle'));
  await waitFor(() => expect(appInfo).toHaveBeenCalledTimes(1));
  await act(async () => {});
  expect(screen.getByTestId('about-facts')).toBeTruthy();
  expect(screen.queryByText(/^Version /)).toBeNull();
  unmount();
  render(<AboutSection appInfo={async () => ({ version: 'unknown', build: 'unknown' })} />);
  fireEvent.press(screen.getByTestId('about-toggle'));
  await act(async () => {});
  expect(screen.getByTestId('about-facts')).toBeTruthy();
  expect(screen.queryByText(/^Version /)).toBeNull();
});

// Decision D9: the four URLs.
it.each(ABOUT_LINKS.map((l) => [l.id, l.url] as const))('opens the %s link in the system browser', (id, url) => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  render(<AboutSection />);
  fireEvent.press(screen.getByTestId('about-toggle'));
  fireEvent.press(screen.getByTestId('about-link-' + id));
  expect(open).toHaveBeenCalledWith(url);
});

it('pins the link targets', () => {
  expect(ABOUT_LINKS.map((l) => l.url)).toEqual([
    'https://x.com/darshitpp',
    'https://www.linkedin.com/in/darshitpp',
    'https://github.com/darshitpp',
    'https://github.com/darshitpp/daak',
  ]);
  expect(ABOUT_LINKS.map((l) => l.handle)).toEqual(['@darshitpp', 'in/darshitpp', '@darshitpp', 'github.com/darshitpp/daak']);
});

// Decision D2: the app makes no request. It opens the releases page.
it('opens the releases page from Check for updates', () => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  render(<AboutSection />);
  expect(screen.getByText('See whether Daak needs an update')).toBeTruthy();
  fireEvent.press(screen.getByTestId('check-for-updates'));
  expect(open).toHaveBeenCalledWith(RELEASES_URL);
  expect(RELEASES_URL).toBe('https://github.com/darshitpp/daak/releases/latest');
});

it('says so when the browser cannot open the link', async () => {
  jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('no handler'));
  render(<AboutSection />);
  fireEvent.press(screen.getByTestId('check-for-updates'));
  await waitFor(() => expect(screen.getByTestId('about-open-error')).toBeTruthy());
});

it('keeps each link row at 44 points or more', () => {
  render(<AboutSection />);
  fireEvent.press(screen.getByTestId('about-toggle'));
  const style = screen.getByTestId('about-link-twitter').props.style;
  const flat = Array.isArray(style) ? Object.assign({}, ...style.flat().filter(Boolean)) : style;
  expect(flat.minHeight).toBeGreaterThanOrEqual(44);
});

// Task 8A: the section is collapsible.
const flatStyle = (id: string) => {
  const style = screen.getByTestId(id).props.style;
  return Array.isArray(style) ? Object.assign({}, ...style.flat().filter(Boolean)) : style;
};

it('starts collapsed and shows the facts after a tap', () => {
  render(<AboutSection />);
  expect(screen.queryByTestId('about-facts')).toBeNull();
  expect(screen.getByTestId('about-toggle').props.accessibilityState.expanded).toBe(false);
  fireEvent.press(screen.getByTestId('about-toggle'));
  expect(screen.getByTestId('about-facts')).toBeTruthy();
  expect(screen.getByTestId('about-links')).toBeTruthy();
});

it('hides the facts and the links on a tap and sets expanded to false', () => {
  render(<AboutSection />);
  // The section starts collapsed: the first press opens it, the second closes it.
  fireEvent.press(screen.getByTestId('about-toggle'));
  fireEvent.press(screen.getByTestId('about-toggle'));
  expect(screen.getByTestId('about-toggle').props.accessibilityState.expanded).toBe(false);
  expect(screen.queryByTestId('about-facts')).toBeNull();
  expect(screen.queryByTestId('about-links')).toBeNull();
});

it('shows them again on a second tap', () => {
  render(<AboutSection />);
  // Open, close, then open again: three presses from the collapsed start.
  fireEvent.press(screen.getByTestId('about-toggle'));
  fireEvent.press(screen.getByTestId('about-toggle'));
  fireEvent.press(screen.getByTestId('about-toggle'));
  expect(screen.getByTestId('about-toggle').props.accessibilityState.expanded).toBe(true);
  expect(screen.getByTestId('about-facts')).toBeTruthy();
  expect(screen.getByTestId('about-links')).toBeTruthy();
});

it('keeps Check for updates visible and working when collapsed', () => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  render(<AboutSection />);
  expect(screen.getByText('See whether Daak needs an update')).toBeTruthy();
  fireEvent.press(screen.getByTestId('check-for-updates'));
  expect(open).toHaveBeenCalledWith(RELEASES_URL);
});

it('keeps the toggle at 44 points or more', () => {
  render(<AboutSection />);
  expect(flatStyle('about-toggle').minHeight).toBeGreaterThanOrEqual(44);
});

it('puts the facts and the links in separate views', async () => {
  render(<AboutSection appInfo={async () => ({ version: '0.4.2', build: '1180' })} />);
  fireEvent.press(screen.getByTestId('about-toggle'));
  const facts = screen.getByTestId('about-facts');
  const links = screen.getByTestId('about-links');
  expect(facts).not.toBe(links);
  expect(within(facts).getByText('Works on')).toBeTruthy();
  expect(await within(facts).findByText('Version 0.4.2 (build 1180)')).toBeTruthy();
  expect(within(facts).queryByText('Twitter')).toBeNull();
  expect(within(links).getByText('Twitter')).toBeTruthy();
  expect(within(links).getByText('github.com/darshitpp/daak')).toBeTruthy();
  expect(within(links).queryByText('Works on')).toBeNull();
});

const textStyle = (text: string) => {
  const style = screen.getByText(text).props.style;
  return Array.isArray(style) ? Object.assign({}, ...style.flat().filter(Boolean)) : style;
};

// The prototype `.section-t` class with the weight of `.section-t-btn`.
it('draws the header title as a muted small section title', () => {
  render(<AboutSection />);
  expect(textStyle('About Daak')).toMatchObject({ fontSize: type.sm, color: colors.muted, fontWeight: '600' });
});

it('draws the update line as a hint', () => {
  render(<AboutSection />);
  expect(textStyle('See whether Daak needs an update')).toMatchObject(ui.hint);
});

it('hides the chevron from accessibility', () => {
  render(<AboutSection />);
  const chevron = screen.getByTestId('about-chevron', { includeHiddenElements: true });
  expect(chevron.props.accessibilityElementsHidden).toBe(true);
  expect(chevron.props.importantForAccessibility).toBe('no-hide-descendants');
});

it('the About text says that apps with storage access can read received files', () => {
  render(<AboutSection />);
  fireEvent.press(screen.getByTestId('about-toggle'));
  expect(screen.getByText(/apps with storage access can read/i)).toBeTruthy();
});

it('the About text says that Documents is in the device backup on iOS', () => {
  render(<AboutSection />);
  fireEvent.press(screen.getByTestId('about-toggle'));
  expect(screen.getByText(/On iOS, the Documents folder is in the device backup/)).toBeTruthy();
});
