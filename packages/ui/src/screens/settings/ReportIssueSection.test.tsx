import React from 'react';
import { Linking } from 'react-native';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { EngineProvider } from '../../EngineContext';
import { fakeEngine } from '../../testing/fakeEngine';
import { ISSUES_URL } from '../about-links';
import { MAX_REPORT_CHARS, ReportIssueSection } from './ReportIssueSection';
import type { SettingsHost } from './host';

const mockShow = jest.fn();
jest.mock('../../components/Toast', () => ({ useToast: () => ({ show: mockShow }) }));

const FENCE_OPEN = '```text\n';
const FENCE_CLOSE = '\n```';
const fenced = (t: string) => FENCE_OPEN + t + FENCE_CLOSE;

let openURL: jest.SpyInstance;
beforeEach(() => {
  mockShow.mockClear();
  openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  openURL.mockClear();
});
// A failed assertion must not leak a console spy into the next test.
afterEach(() => jest.restoreAllMocks());

const setup = (
  copy: (text: string) => Promise<void>,
  bundle: () => Promise<string> = async () => 'LOG',
  extra: Omit<SettingsHost, 'reportIssue'> = {},
) => {
  const engine = fakeEngine([]);
  const exportDebugBundle = jest.spyOn(engine, 'exportDebugBundle').mockImplementation(bundle);
  render(
    <EngineProvider engine={engine}>
      <ReportIssueSection host={{ ...extra, reportIssue: { copy } }} />
    </EngineProvider>,
  );
  return { exportDebugBundle };
};
const tap = async () => {
  await act(async () => {
    fireEvent.press(screen.getByTestId('report-issue'));
  });
};
const idle = () => {
  expect(within(screen.getByTestId('report-issue')).getByText('Report an issue')).toBeTruthy();
  expect(screen.getByTestId('report-issue').props.accessibilityState?.disabled).toBeFalsy();
  expect(screen.queryByText('Preparing…')).toBeNull();
};

it('renders nothing when host.reportIssue is absent', () => {
  render(
    <EngineProvider engine={fakeEngine([])}>
      <ReportIssueSection host={{}} />
    </EngineProvider>,
  );
  expect(screen.queryByTestId('report-issue')).toBeNull();
  expect(screen.queryByText('Something went wrong?')).toBeNull();
});

it('shows the row and the hint', () => {
  setup(async () => {});
  expect(screen.getByText('Something went wrong?')).toBeTruthy();
  expect(
    screen.getByText(
      'Copies the app version, the OS, the device model, and a short log of what Daak did recently, then opens GitHub. Paste it into a new issue. Issues are public, so read the log first. Daak sends nothing by itself.',
    ),
  ).toBeTruthy();
});

it('copies the fenced text and opens the issues URL once, in order', async () => {
  const order: string[] = [];
  const copy = jest.fn(async (_t: string) => { order.push('copy'); });
  const { exportDebugBundle } = setup(copy, async () => { order.push('bundle'); return 'THE TEXT'; }, {
    appInfo: async () => ({ version: '0.1.4', build: '7' }),
  });
  mockShow.mockImplementation(() => { order.push('toast'); });
  openURL.mockImplementation(async () => { order.push('open'); return true; });
  await tap();
  expect(exportDebugBundle).toHaveBeenCalledTimes(1);
  expect(copy).toHaveBeenCalledTimes(1);
  expect(copy).toHaveBeenCalledWith(fenced('app: 0.1.4 (build 7)\nTHE TEXT'));
  expect(openURL).toHaveBeenCalledTimes(1);
  expect(openURL).toHaveBeenCalledWith(ISSUES_URL);
  expect(ISSUES_URL).toBe('https://github.com/darshitpp/daak/issues/new');
  expect(mockShow).toHaveBeenCalledWith('Copied · paste it into the issue');
  expect(order).toEqual(['bundle', 'copy', 'toast', 'open']);
  expect(screen.queryByTestId('report-issue-error')).toBeNull();
  idle();
});

it('button is disabled and reads "Preparing…" while busy', async () => {
  let release!: () => void;
  setup(() => new Promise<void>((r) => { release = r; }));
  await tap();
  expect(screen.getByText('Preparing…')).toBeTruthy();
  expect(screen.getByTestId('report-issue').props.accessibilityState?.disabled).toBe(true);
  await act(async () => release());
  idle();
});

it('a rejected exportDebugBundle shows the first note, logs the raw error, and never opens the URL', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const raw = new Error('no root view controller');
  const copy = jest.fn(async (_t: string) => {});
  setup(copy, async () => { throw raw; });
  await tap();
  expect(screen.getByText('The report did not copy')).toBeTruthy();
  expect(screen.getByText('The report could not be copied on this device.')).toBeTruthy();
  expect(screen.queryByText('no root view controller')).toBeNull();
  expect(warn).toHaveBeenCalledWith('daak: report an issue failed:', raw);
  expect(copy).not.toHaveBeenCalled();
  expect(openURL).not.toHaveBeenCalled();
  idle();
});

it('a rejected copy shows the first note, never shows the toast, and never opens the URL', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const raw = new Error('clipboard refused');
  setup(async () => { throw raw; });
  await tap();
  expect(screen.queryByText('clipboard refused')).toBeNull();
  expect(warn).toHaveBeenCalledWith('daak: report an issue failed:', raw);
  expect(screen.getByTestId('report-issue-error')).toBeTruthy();
  expect(screen.getByText('The report did not copy')).toBeTruthy();
  expect(screen.getByText('The report could not be copied on this device.')).toBeTruthy();
  expect(mockShow).not.toHaveBeenCalled();
  expect(openURL).not.toHaveBeenCalled();
  idle();
});

it('a rejected openURL shows the second note and logs the raw error', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const raw = new Error('no handler');
  openURL.mockRejectedValue(raw);
  setup(async () => {});
  await tap();
  expect(screen.getByTestId('report-issue-error')).toBeTruthy();
  expect(screen.getByText('The report is copied')).toBeTruthy();
  expect(
    screen.getByText('Open github.com/darshitpp/daak/issues/new in a browser, then paste.'),
  ).toBeTruthy();
  expect(screen.queryByText('no handler')).toBeNull();
  expect(warn).toHaveBeenCalledWith('daak: report an issue failed:', raw);
  idle();
});

it('clears the old note when the button is pressed again', async () => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  let fail = true;
  setup(async () => { if (fail) throw new Error('x'); });
  await tap();
  expect(screen.getByTestId('report-issue-error')).toBeTruthy();
  fail = false;
  await tap();
  expect(screen.queryByTestId('report-issue-error')).toBeNull();
});

it('a second press while busy copies once', async () => {
  let release!: () => void;
  const copy = jest.fn((_t: string) => new Promise<void>((r) => { release = r; }));
  const { exportDebugBundle } = setup(copy);
  await tap();
  await tap();
  expect(exportDebugBundle).toHaveBeenCalledTimes(1);
  expect(copy).toHaveBeenCalledTimes(1);
  await act(async () => release());
});

// A disabled Pressable ignores the press, so this test calls the handler twice
// in one tick, before the re-render. Only the busyRef guard stops the second call.
it('two presses in the same tick copy once', async () => {
  const copy = jest.fn((_t: string) => new Promise<void>(() => {}));
  const { exportDebugBundle } = setup(copy);
  const button = screen.getByTestId('report-issue');
  await act(async () => {
    fireEvent.press(button);
    fireEvent.press(button);
  });
  expect(exportDebugBundle).toHaveBeenCalledTimes(1);
  expect(copy).toHaveBeenCalledTimes(1);
});

it('copies the fenced bundle text unchanged when appInfo rejects', async () => {
  const copy = jest.fn(async (_t: string) => {});
  setup(copy, async () => 'THE TEXT', {
    appInfo: async () => {
      throw new Error('no native module');
    },
  });
  await tap();
  expect(copy).toHaveBeenCalledWith(fenced('THE TEXT'));
  expect(screen.queryByTestId('report-issue-error')).toBeNull();
  idle();
});

it('copies the fenced bundle text unchanged when the app version is unknown', async () => {
  const copy = jest.fn(async (_t: string) => {});
  setup(copy, async () => 'THE TEXT', { appInfo: async () => ({ version: 'unknown', build: 'unknown' }) });
  await tap();
  expect(copy).toHaveBeenCalledWith(fenced('THE TEXT'));
});

it('cuts a long bundle to at most 60,000 units on a line boundary and keeps the header', async () => {
  expect(MAX_REPORT_CHARS).toBe(60_000);
  const head = '=== daak debug bundle ===\n=== version ===\ndaak-ffi 0.1.0\n=== recent log ===\n';
  const lines = Array.from({ length: 3000 }, (_, i) => `line ${String(i).padStart(4, '0')} ${'x'.repeat(80)}\n`);
  const copy = jest.fn(async (_t: string) => {});
  setup(copy, async () => head + lines.join(''), {
    appInfo: async () => ({ version: '0.1.4', build: '7' }),
  });
  await tap();
  const sent = copy.mock.calls[0][0];
  const top = FENCE_OPEN + 'app: 0.1.4 (build 7)\n' + head;
  expect(sent.length).toBeLessThanOrEqual(MAX_REPORT_CHARS);
  expect(sent.startsWith(top)).toBe(true);
  expect(sent.endsWith(lines[2999] + '\n```')).toBe(true);
  expect(sent).not.toContain('line 0000 ');
  // The cut is on a line boundary: every log line is whole.
  const log = sent.slice(top.length, sent.length - FENCE_CLOSE.length);
  expect(log.split('\n').filter((l) => l !== '').every((l) => /^line \d{4} x{80}$/.test(l))).toBe(true);
});

it('keeps a report at the limit unchanged', async () => {
  const text = 'a\n'.repeat((MAX_REPORT_CHARS - FENCE_OPEN.length - FENCE_CLOSE.length) / 2);
  const copy = jest.fn(async (_t: string) => {});
  setup(copy, async () => text);
  await tap();
  expect(copy).toHaveBeenCalledWith(fenced(text));
  expect(copy.mock.calls[0][0].length).toBe(MAX_REPORT_CHARS);
});

it('puts the app, OS, device, and paired lines before the log, with no peer name', async () => {
  const copy = jest.fn(async (_t: string) => {});
  const engine = fakeEngine([
    { deviceId: 'd1', name: 'Secret Phone', addr: '10.0.0.9:1', paired: true, presence: 'online' },
    { deviceId: 'd2', name: 'Other Mac', addr: '10.0.0.8:1', paired: true, presence: 'offline' },
    { deviceId: 'd3', name: 'Stranger', addr: '10.0.0.7:1', paired: false },
  ]);
  jest.spyOn(engine, 'exportDebugBundle').mockResolvedValue('LOG');
  render(
    <EngineProvider engine={engine}>
      <ReportIssueSection
        host={{
          appInfo: async () => ({ version: '0.1.4', build: '7' }),
          deviceInfo: () => 'os: android 16 (API 36)\ndevice: Acme Phone X1\n',
          reportIssue: { copy },
        }}
      />
    </EngineProvider>,
  );
  await tap();
  expect(copy).toHaveBeenCalledWith(
    fenced('app: 0.1.4 (build 7)\nos: android 16 (API 36)\ndevice: Acme Phone X1\npaired: 2 (online 1, away 0, offline 1)\nLOG'),
  );
  expect(copy.mock.calls[0][0]).not.toContain('Secret Phone');
  expect(copy.mock.calls[0][0]).not.toContain('10.0.0');
});

it('still copies when deviceInfo throws or devices() rejects', async () => {
  const copy = jest.fn(async (_t: string) => {});
  const engine = fakeEngine([]);
  jest.spyOn(engine, 'exportDebugBundle').mockResolvedValue('LOG');
  jest.spyOn(engine, 'devices').mockRejectedValue(new Error('down'));
  render(
    <EngineProvider engine={engine}>
      <ReportIssueSection host={{ deviceInfo: () => { throw new Error('x'); }, reportIssue: { copy } }} />
    </EngineProvider>,
  );
  await tap();
  expect(copy).toHaveBeenCalledWith(fenced('LOG'));
});
