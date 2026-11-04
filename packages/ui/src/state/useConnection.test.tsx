import React from 'react';
import { Text } from 'react-native';
import { act, render, renderAsync, screen } from '@testing-library/react-native';
import type { DaakEngine, DaakEvent, DeviceInfo } from '@daak/core';
import { fakeEngine } from '../testing/fakeEngine';
import { useConnection } from './useConnection';

function Probe({ engine }: { engine: DaakEngine }) {
  const c = useConnection(engine);
  return <Text testID="c">{c.status + '/' + c.wifi}</Text>;
}
const dev = (presence: DeviceInfo['presence']): DeviceInfo => ({ deviceId: 'aa'.repeat(16), name: 'P', addr: '', presence, online: presence !== 'offline', paired: true });

it('starts unknown', async () => {
  render(<Probe engine={fakeEngine([])} />);
  expect(screen.getByTestId('c').props.children).toBe('unknown/unknown');
  // The read that follows must finish inside act.
  await act(async () => {});
});

it('reports connected when a paired device is on this network', async () => {
  await renderAsync(<Probe engine={fakeEngine([dev('online')])} />);
  expect(await screen.findByText('working/connected')).toBeTruthy();
});

it('reports connected for an away device, which still receives', async () => {
  await renderAsync(<Probe engine={fakeEngine([dev('away')])} />);
  expect(await screen.findByText('working/connected')).toBeTruthy();
});

it('reports not connected when every device is offline or none exists', async () => {
  const { unmountAsync } = await renderAsync(<Probe engine={fakeEngine([dev('offline')])} />);
  expect(await screen.findByText('working/not-connected')).toBeTruthy();
  await unmountAsync();
  await renderAsync(<Probe engine={fakeEngine([])} />);
  expect(await screen.findByText('working/not-connected')).toBeTruthy();
});

// HEAD 824b3d7: a pairing stays pending until the user confirms the SAS. A
// pending peer, and any nearby unpaired peer, has paired false. It must not
// count as "a paired device on this network".
it('does not count an unpaired or pending peer as connected', async () => {
  await renderAsync(<Probe engine={fakeEngine([{ ...dev('online'), paired: false, presence: undefined }])} />);
  expect(await screen.findByText('working/not-connected')).toBeTruthy();
});

it('re-reads when a pairing is confirmed or revoked', async () => {
  const engine = fakeEngine([{ ...dev('online'), paired: false, presence: undefined }]);
  const spy = jest.spyOn(engine, 'devices');
  await renderAsync(<Probe engine={engine} />);
  await screen.findByText('working/not-connected');
  spy.mockResolvedValue([dev('online')]);
  act(() => {
    (engine as unknown as { __handlers: Set<(e: DaakEvent) => void> }).__handlers.forEach((h) =>
      h({ type: 'pairing.done', deviceId: 'aa'.repeat(16) }),
    );
  });
  expect(await screen.findByText('working/connected')).toBeTruthy();
  spy.mockResolvedValue([{ ...dev('online'), paired: false, presence: undefined }]);
  act(() => {
    (engine as unknown as { __handlers: Set<(e: DaakEvent) => void> }).__handlers.forEach((h) =>
      h({ type: 'pairing.revoked', deviceId: 'aa'.repeat(16) }),
    );
  });
  expect(await screen.findByText('working/not-connected')).toBeTruthy();
});

it('reports not working when the engine rejects', async () => {
  const engine = fakeEngine([]);
  jest.spyOn(engine, 'devices').mockRejectedValue(new Error('engine not started'));
  await renderAsync(<Probe engine={engine} />);
  expect(await screen.findByText('not-working/unknown')).toBeTruthy();
});

it('re-reads on a presence event and stops after unmount', async () => {
  const engine = fakeEngine([dev('offline')]);
  const spy = jest.spyOn(engine, 'devices');
  const { unmountAsync } = await renderAsync(<Probe engine={engine} />);
  await screen.findByText('working/not-connected');
  spy.mockResolvedValue([dev('online')]);
  act(() => {
    (engine as unknown as { __handlers: Set<(e: DaakEvent) => void> }).__handlers.forEach((h) =>
      h({ type: 'device.presence', deviceId: 'aa'.repeat(16), presence: 'online' }),
    );
  });
  expect(await screen.findByText('working/connected')).toBeTruthy();
  await unmountAsync();
  expect((engine as unknown as { __handlers: Set<unknown> }).__handlers.size).toBe(0);
});

