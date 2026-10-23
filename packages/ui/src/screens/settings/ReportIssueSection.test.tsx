import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { EngineProvider } from '../../EngineContext';
import { fakeEngine } from '../../testing/fakeEngine';
import { MAX_SHARE_CHARS, ReportIssueSection } from './ReportIssueSection';
import type { SettingsHost } from './host';

// A failed assertion must not leak a console spy into the next test.
afterEach(() => jest.restoreAllMocks());

const setup = (
  share: (text: string) => Promise<void>,
  bundle: () => Promise<string> = async () => 'LOG',
  extra: Omit<SettingsHost, 'reportIssue'> = {},
) => {
  const engine = fakeEngine([]);
  const exportDebugBundle = jest.spyOn(engine, 'exportDebugBundle').mockImplementation(bundle);
  render(
    <EngineProvider engine={engine}>
      <ReportIssueSection host={{ ...extra, reportIssue: { share } }} />
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
  expect(screen.getByText(/Daak sends nothing by itself\.$/)).toBeTruthy();
});

it('tap calls exportDebugBundle then share with the same text', async () => {
  const share = jest.fn(async (_t: string) => {});
  const { exportDebugBundle } = setup(share, async () => 'THE TEXT');
  await tap();
  expect(exportDebugBundle).toHaveBeenCalledTimes(1);
  expect(share).toHaveBeenCalledWith('THE TEXT');
  idle();
  expect(screen.queryByTestId('report-issue-error')).toBeNull();
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

it('a rejected exportDebugBundle shows the fixed note, logs the raw error, and returns to idle', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const raw = new Error('no root view controller');
  const share = jest.fn(async (_t: string) => {});
  setup(share, async () => { throw raw; });
  await tap();
  expect(screen.getByText('The report did not open')).toBeTruthy();
  expect(screen.getByText('The share sheet could not open on this device.')).toBeTruthy();
  expect(screen.queryByText('no root view controller')).toBeNull();
  expect(warn).toHaveBeenCalledWith('daak: report an issue failed:', raw);
  expect(share).not.toHaveBeenCalled();
  idle();
});

it('a rejected share shows the fixed note, logs the raw error, and returns to idle', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const raw = new Error('nothing to share');
  setup(async () => { throw raw; });
  await tap();
  expect(screen.queryByText('nothing to share')).toBeNull();
  expect(warn).toHaveBeenCalledWith('daak: report an issue failed:', raw);
  expect(screen.getByTestId('report-issue-error')).toBeTruthy();
  expect(screen.getByText('The share sheet could not open on this device.')).toBeTruthy();
  idle();
});

it('clears the old note when the button is pressed again', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  let fail = true;
  setup(async () => { if (fail) throw new Error('x'); });
  await tap();
  expect(screen.getByTestId('report-issue-error')).toBeTruthy();
  fail = false;
  await tap();
  expect(screen.queryByTestId('report-issue-error')).toBeNull();
});

it('a dismissed share sheet (share resolves) shows no note', async () => {
  setup(async () => {});
  await tap();
  expect(screen.queryByTestId('report-issue-error')).toBeNull();
  idle();
});

it('a second press while busy calls exportDebugBundle once', async () => {
  let release!: () => void;
  const { exportDebugBundle } = setup(() => new Promise<void>((r) => { release = r; }));
  await tap();
  await tap();
  expect(exportDebugBundle).toHaveBeenCalledTimes(1);
  await act(async () => release());
});

// A disabled Pressable ignores the press, so this test calls the handler twice
// in one tick, before the re-render. Only the busyRef guard stops the second call.
it('two presses in the same tick call exportDebugBundle once', async () => {
  const { exportDebugBundle } = setup(() => new Promise<void>(() => {}));
  const button = screen.getByTestId('report-issue');
  await act(async () => {
    fireEvent.press(button);
    fireEvent.press(button);
  });
  expect(exportDebugBundle).toHaveBeenCalledTimes(1);
});

it('puts the app version line before the bundle text', async () => {
  const share = jest.fn(async (_t: string) => {});
  setup(share, async () => 'THE TEXT', { appInfo: async () => ({ version: '0.1.4', build: '7' }) });
  await tap();
  expect(share).toHaveBeenCalledWith('app: 0.1.4 (build 7)\nTHE TEXT');
  idle();
});

it('sends the bundle text unchanged when appInfo rejects', async () => {
  const share = jest.fn(async (_t: string) => {});
  setup(share, async () => 'THE TEXT', {
    appInfo: async () => {
      throw new Error('no native module');
    },
  });
  await tap();
  expect(share).toHaveBeenCalledWith('THE TEXT');
  expect(screen.queryByTestId('report-issue-error')).toBeNull();
  idle();
});

it('sends the bundle text unchanged when the app version is unknown', async () => {
  const share = jest.fn(async (_t: string) => {});
  setup(share, async () => 'THE TEXT', { appInfo: async () => ({ version: 'unknown', build: 'unknown' }) });
  await tap();
  expect(share).toHaveBeenCalledWith('THE TEXT');
});

it('cuts a long bundle to the newest whole lines and keeps the header lines', async () => {
  const head = '=== daak debug bundle ===\n=== version ===\ndaak-ffi 0.1.0\n=== recent log ===\n';
  const lines = Array.from({ length: 3000 }, (_, i) => `line ${String(i).padStart(4, '0')} ${'x'.repeat(80)}\n`);
  const share = jest.fn(async (_t: string) => {});
  setup(share, async () => head + lines.join(''), {
    appInfo: async () => ({ version: '0.1.4', build: '7' }),
  });
  await tap();
  const sent = share.mock.calls[0][0];
  expect(sent.length).toBeLessThanOrEqual(MAX_SHARE_CHARS);
  expect(sent.startsWith('app: 0.1.4 (build 7)\n' + head)).toBe(true);
  expect(sent.endsWith(lines[2999])).toBe(true);
  expect(sent).not.toContain('line 0000 ');
  // The cut is on a line boundary: every log line is whole.
  const log = sent.slice(('app: 0.1.4 (build 7)\n' + head).length);
  expect(log.split('\n').filter((l) => l !== '').every((l) => /^line \d{4} x{80}$/.test(l))).toBe(true);
});

it('keeps a bundle at the limit unchanged', async () => {
  const text = 'a\n'.repeat(MAX_SHARE_CHARS / 2);
  const share = jest.fn(async (_t: string) => {});
  setup(share, async () => text);
  await tap();
  expect(share).toHaveBeenCalledWith(text);
});
