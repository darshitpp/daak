import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { EngineProvider } from '../../EngineContext';
import { fakeEngine } from '../../testing/fakeEngine';
import { ReportIssueSection } from './ReportIssueSection';

const setup = (share: (text: string) => Promise<void>, bundle: () => Promise<string> = async () => 'LOG') => {
  const engine = fakeEngine([]);
  const exportDebugBundle = jest.spyOn(engine, 'exportDebugBundle').mockImplementation(bundle);
  render(
    <EngineProvider engine={engine}>
      <ReportIssueSection host={{ reportIssue: { share } }} />
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

it('a rejected exportDebugBundle shows the error note and returns to idle', async () => {
  const share = jest.fn(async (_t: string) => {});
  setup(share, async () => { throw new Error('bundle broke'); });
  await tap();
  expect(screen.getByText('The report did not open')).toBeTruthy();
  expect(screen.getByText('bundle broke')).toBeTruthy();
  expect(share).not.toHaveBeenCalled();
  idle();
});

it('a rejected share shows the error note, with a fallback message, and returns to idle', async () => {
  setup(async () => { throw 'nope'; });
  await tap();
  expect(screen.getByTestId('report-issue-error')).toBeTruthy();
  expect(screen.getByText('The share sheet could not open on this device.')).toBeTruthy();
  idle();
});

it('clears the old note when the button is pressed again', async () => {
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
