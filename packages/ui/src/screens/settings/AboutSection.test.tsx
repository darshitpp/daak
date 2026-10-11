import React from 'react';
import { Linking } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AboutSection } from './AboutSection';
import { ABOUT_LINKS, RELEASES_URL } from '../about-links';

afterEach(() => jest.restoreAllMocks());

it('shows the four facts', () => {
  render(<AboutSection />);
  expect(screen.getByText('This Wi-Fi only')).toBeTruthy();
  expect(screen.getByText('No account, none')).toBeTruthy();
  expect(screen.getByText('On your devices')).toBeTruthy();
});

// appInfo is async (P2). The row shows only after the host answers.
it('shows the real version and build after the host answers, and no row without a host', async () => {
  const { unmount } = render(<AboutSection appInfo={async () => ({ version: '0.4.2', build: '1180' })} />);
  expect(screen.queryByText(/^Version /)).toBeNull();
  expect(await screen.findByText('Version 0.4.2 (build 1180)')).toBeTruthy();
  unmount();
  render(<AboutSection />);
  await act(async () => {});
  expect(screen.queryByText(/^Version /)).toBeNull();
});

it('hides the version row when the host rejects or reports unknown', async () => {
  const appInfo = jest.fn().mockRejectedValueOnce(new Error('no native module'));
  const { unmount } = render(<AboutSection appInfo={appInfo} />);
  await waitFor(() => expect(appInfo).toHaveBeenCalledTimes(1));
  await act(async () => {});
  expect(screen.queryByText(/^Version /)).toBeNull();
  unmount();
  render(<AboutSection appInfo={async () => ({ version: 'unknown', build: 'unknown' })} />);
  await act(async () => {});
  expect(screen.queryByText(/^Version /)).toBeNull();
});

// Decision D9: the four URLs.
it.each(ABOUT_LINKS.map((l) => [l.id, l.url] as const))('opens the %s link in the system browser', (id, url) => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  render(<AboutSection />);
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
  const style = screen.getByTestId('about-link-twitter').props.style;
  const flat = Array.isArray(style) ? Object.assign({}, ...style.flat().filter(Boolean)) : style;
  expect(flat.minHeight).toBeGreaterThanOrEqual(44);
});

