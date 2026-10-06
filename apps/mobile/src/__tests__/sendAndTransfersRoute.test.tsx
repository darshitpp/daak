import React from 'react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { DeviceInfo } from '@daak/core';
import { AppShell, EngineProvider, fakeEngine } from '@daak/ui';

// M1 + I1, the app half. These drive the REAL shell, so they fail if the tab
// goes away or if DeviceCard's Send stops routing. The shell's own tests prove
 // the same paths from inside packages/ui; this file pins them from the app
 // side, where the picker is injected and a slot could be dropped.
const engine = fakeEngine();
// `paired: true`: R42g hides Send on a peer the engine would refuse, so the
// fixture this route is asserted against must be paired.
const device: DeviceInfo = { deviceId: 'aa'.repeat(16), name: 'Pixel 9', addr: '192.168.1.9:40001', online: true, paired: true };
const TRANSFER_ID = 'bb'.repeat(16);

function Shell() {
  return (
    <EngineProvider engine={engine}>
      <AppShell onPickFiles={async () => ['/Users/d/Documents/a.pdf']} />
    </EngineProvider>
  );
}

beforeEach(() => {
  jest.restoreAllMocks();
  jest.spyOn(engine, 'devices').mockResolvedValue([device]);
  jest.spyOn(engine, 'listTransfers').mockResolvedValue([
    {
      transferId: TRANSFER_ID, peerDeviceId: device.deviceId, direction: 'in',
      kind: 'media', state: 'receiving', bytesDone: 1, bytesTotal: 2, itemCount: 1, updatedAt: 5,
    },
  ]);
});

// Tapping Send on a device card must land on a composer bound to THAT device,
// and the engine must receive that device id -- that is the whole difference
// between a route and a no-op.
it('routes the device card Send into the Send tab for that peer', async () => {
  const send = jest.spyOn(engine, 'send').mockResolvedValue({ transferId: TRANSFER_ID, queued: true });
  render(<Shell />);
  fireEvent.press(screen.getByText('Devices'));
  fireEvent.press(await screen.findByLabelText('send-to-' + device.deviceId));
  fireEvent.changeText(await screen.findByPlaceholderText('Message'), 'hello');
  fireEvent.press(screen.getByLabelText('send'));
  await waitFor(() => expect(send).toHaveBeenCalledWith({ peerDeviceId: device.deviceId, text: 'hello', files: [] }));
});

// The send route must not grow its OWN drain: App.tsx is the single drain site
// and it waits for the engine. A second one deletes the batch twice and loses
// the bytes. SendFlow is the file that owns the picker, so it is the place a
// second drain would grow.
it('does not drain the staged share inbox on the way to Send', () => {
  // Comments stripped first: a source pin which can be satisfied by PROSE is
  // decoration, and the file's own comment names drainInbound while saying the
  // opposite.
  const src = readFileSync(join(__dirname, '..', 'SendFlow.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  expect(src).not.toMatch(/drainInbound/);
  expect(src).not.toMatch(/consumePendingShare/);
});

// Two transfers at once used to leave the second invisible: the app-side
// TransfersFlow picked the newest and rendered only that one.
it('shows both transfers, and cancels by the id that was tapped', async () => {
  const other: DeviceInfo = { deviceId: 'cc'.repeat(16), name: 'ThinkPad', addr: '192.168.1.10:40001' };
  const NEW = 'cc'.repeat(16);
  jest.spyOn(engine, 'devices').mockResolvedValue([device, other]);
  jest.spyOn(engine, 'listTransfers').mockResolvedValue([
    { transferId: TRANSFER_ID, peerDeviceId: device.deviceId, direction: 'in', kind: 'media',
      state: 'receiving', bytesDone: 1, bytesTotal: 2, itemCount: 1, updatedAt: 5 },
    { transferId: NEW, peerDeviceId: other.deviceId, direction: 'in', kind: 'media',
      state: 'receiving', bytesDone: 1, bytesTotal: 2, itemCount: 1, updatedAt: 6 },
  ]);
  const cancel = jest.spyOn(engine, 'cancel').mockResolvedValue();
  render(<Shell />);
  fireEvent.press(screen.getByText('Transfers'));
  await waitFor(() => expect(screen.getByText('1 item(s) from ThinkPad')).toBeTruthy());
  expect(screen.getByText('1 item(s) from Pixel 9')).toBeTruthy();
  // The OLDER row, not the newest: the engine gets the id that was tapped.
  fireEvent.press(screen.getByLabelText('cancel-1 item(s) from Pixel 9'));
  await waitFor(() => expect(cancel).toHaveBeenCalledWith(TRANSFER_ID));
});

// The composer's picker is INJECTED (packages/ui takes no dependency on
// @daak/platform and no TurboModule), so packages/platform's pickFiles -- tested
// at packages/platform/src/share.test.ts -- is correct and has no import path to
// this app at all. What can break is the WIRING: a host that supplies no picker
// leaves "Add files" inert, and that is indistinguishable from a working button
// at runtime. So this asserts the path a tap takes, not the facade.
it('sends the paths the injected picker returned', async () => {
  const send = jest.spyOn(engine, 'send').mockResolvedValue({ transferId: TRANSFER_ID, queued: true });
  render(<Shell />);
  fireEvent.press(screen.getByLabelText('pick-files'));
  await waitFor(() => expect(screen.getByText('a.pdf')).toBeTruthy());
  fireEvent.press(screen.getByLabelText('send'));
  await waitFor(() =>
    expect(send).toHaveBeenCalledWith({
      peerDeviceId: device.deviceId,
      text: undefined,
      files: ['/Users/d/Documents/a.pdf'],
    }),
  );
});

// The source-level half of M1. `onSend={() => {}}` shipped in two screens and
// no test could see it: DeviceCard's own test passes a real jest.fn(), so a
// no-op at the call site was invisible. Comments are stripped first and the
// assert is over the whole source tree, so it goes red the moment the dead
// callback comes back anywhere.
describe('no dead onSend callback exists anywhere in the tree', () => {
  const roots = ['packages/ui/src', 'apps/mobile/src'];

  function strip(s: string) {
    return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }

  it('finds no empty onSend callback', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of require('fs').readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) files.push(p);
      }
    };
    for (const r of roots) walk(join(__dirname, '..', '..', '..', '..', r));
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.filter((f) => /onSend\s*=\s*\{\s*\(\)\s*=>\s*\{\s*\}\s*\}/.test(strip(readFileSync(f, 'utf8'))));
    expect(offenders).toEqual([]);
  });
});
