import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { EngineProvider } from '../EngineContext';
import { ComposerScreen } from './ComposerScreen';
import { fakeEngine } from '../testing/fakeEngine';
import type { DaakEngine } from '@daak/core';

const PEER = 'aa'.repeat(16);

function spyEngine(): { engine: DaakEngine; send: jest.Mock } {
  const send = jest.fn(async () => ({ transferId: PEER, queued: true }));
  return { engine: { ...fakeEngine(), send }, send };
}

describe('ComposerScreen', () => {
  it('disables send until text or a file is present', () => {
    render(
      <EngineProvider engine={fakeEngine()}>
        <ComposerScreen />
      </EngineProvider>,
    );
    expect(screen.getByLabelText('send')).toBeDisabled();
  });

  // The shipped composer used to fabricate `/tmp/${Date.now()}.bin`, so "Add
  // files" queued a send of a path that does not exist. With no picker supplied
  // there is nothing honest to do, so it does nothing -- no invented path, no
  // throw. This test is what makes a second fabricator impossible to reintroduce.
  it('adds nothing when no picker is supplied', () => {
    render(
      <EngineProvider engine={fakeEngine()}>
        <ComposerScreen peerDeviceId={PEER} />
      </EngineProvider>,
    );
    fireEvent.press(screen.getByLabelText('pick-files'));
    expect(screen.getByText('0 file(s)')).toBeTruthy();
  });

  // The whole point of the injected picker: the paths it returns are the paths
  // that reach engine.send. A picker whose result is dropped, or a composer that
  // substitutes a placeholder, fails on the send assertion, not on a label.
  it('appends the injected picker paths and sends exactly those', async () => {
    const { engine, send } = spyEngine();
    const onPickFiles = jest.fn(async () => ['/Users/d/Documents/a.pdf']);
    render(
      <EngineProvider engine={engine}>
        <ComposerScreen peerDeviceId={PEER} onPickFiles={onPickFiles} />
      </EngineProvider>,
    );
    fireEvent.press(screen.getByLabelText('pick-files'));
    await waitFor(() => expect(screen.getByText('a.pdf')).toBeTruthy());
    fireEvent.press(screen.getByLabelText('send'));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        peerDeviceId: PEER,
        text: undefined,
        files: ['/Users/d/Documents/a.pdf'],
      }),
    );
  });

  // A dismissed picker is not an error: it resolves with an empty array, and a
  // composer that appended nothing must leave the existing attachments alone.
  it('leaves the list alone when the picker is dismissed', async () => {
    const { engine, send } = spyEngine();
    render(
      <EngineProvider engine={engine}>
        <ComposerScreen
          peerDeviceId={PEER}
          initialFiles={['/Users/d/Documents/keep.txt']}
          onPickFiles={async () => []}
        />
      </EngineProvider>,
    );
    fireEvent.press(screen.getByLabelText('pick-files'));
    fireEvent.press(screen.getByLabelText('send'));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        peerDeviceId: PEER,
        text: undefined,
        files: ['/Users/d/Documents/keep.txt'],
      }),
    );
  });

  // The picker is a prop, so nothing stops a host from handing over one that
  // REJECTS. Both native pickers resolve with an empty list on Cancel, so this
  // is not reachable from either platform today -- but a bare
  // `onPickFiles().then(...)` leaves the rejection unhandled, and in the
  // shipped app that is a red box over a picker that failed for any reason at
  // all. Swallowing it keeps the button inert, which is the honest outcome:
  // the user picks nothing and the composer still works.
  it('swallows a rejected picker instead of leaving an unhandled rejection', async () => {
    const { engine, send } = spyEngine();
    render(
      <EngineProvider engine={engine}>
        <ComposerScreen
          peerDeviceId={PEER}
          onPickFiles={() => Promise.reject(new Error('panel unavailable'))}
        />
      </EngineProvider>,
    );
    fireEvent.press(screen.getByLabelText('pick-files'));
    // Let the rejection settle, then prove the composer is still usable and
    // still sends what it had.
    await waitFor(() => expect(screen.getByText('0 file(s)')).toBeTruthy());
    fireEvent.changeText(screen.getByPlaceholderText('Message'), 'hi');
    fireEvent.press(screen.getByLabelText('send'));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        peerDeviceId: PEER,
        text: 'hi',
        files: [],
      }),
    );
  });
});
