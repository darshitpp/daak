import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { EngineProvider } from '../EngineContext';
import { SendScreen } from './SendScreen';
import { fakeEngine } from '../testing/fakeEngine';
import type { DaakEngine } from '@daak/core';

// The shipped Send screen read the device list once on mount and never again.
// The engine is not up on mount, so that read lost the race on every launch:
// the note said "No device list" and NOTHING ever cleared it, because a later
// success had no trigger. The user saw an empty composer against an engine
// that was running the whole time. This pins the recovery.
describe('SendScreen device list', () => {
  it('recovers when the engine answers on a retry', async () => {
    jest.useFakeTimers();
    try {
      let calls = 0;
      const peer = { deviceId: 'ab'.repeat(16), name: 'Peer', addr: '10.0.0.2:1' };
      const engine: DaakEngine = {
        ...fakeEngine(),
        devices: jest.fn(async () => {
          calls += 1;
          // Exactly the launch shape: the first read loses the startup race,
          // the second succeeds once the engine is up.
          if (calls === 1) throw new Error('engine not started');
          return [peer];
        }),
      } as DaakEngine;

      render(
        <EngineProvider engine={engine}>
          <SendScreen />
        </EngineProvider>,
      );

      await waitFor(() => expect(screen.getByText('No device list')).toBeTruthy());

      await act(async () => {
        jest.advanceTimersByTime(1000);
      });

      // The note is GONE and the peer is listed. Clearing it on success is the
      // whole fix: the old screen set the note and left it for the session.
      await waitFor(() => expect(screen.queryByText('No device list')).toBeNull());
      expect(screen.getByText('Peer')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the note when the engine never answers', async () => {
    jest.useFakeTimers();
    try {
      const engine = {
        ...fakeEngine(),
        devices: jest.fn(async () => {
          throw new Error('engine not started');
        }),
      } as unknown as DaakEngine;

      render(
        <EngineProvider engine={engine}>
          <SendScreen />
        </EngineProvider>,
      );

      await waitFor(() => expect(screen.getByText('No device list')).toBeTruthy());
      await act(async () => {
        jest.advanceTimersByTime(9000);
      });
      // Bounded: a dead engine settles into the note instead of polling.
      expect((engine.devices as jest.Mock).mock.calls.length).toBeLessThanOrEqual(9);
      expect(screen.getByText('No device list')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });
});
