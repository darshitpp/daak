import React from 'react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { DeviceInfo, TransferSummary } from '@daak/core';
import { AppShell, EngineProvider, fakeEngine } from '@daak/ui';

// The app half of the thread route. These drive the REAL shell, so they fail
// if the thread route goes away or if the device row stops opening it. The
// shell's own tests prove the same paths from inside packages/ui. This file
// pins them from the app side, where the picker is injected and a slot could be
// dropped.
const engine = fakeEngine();
const device: DeviceInfo = { deviceId: 'aa'.repeat(16), name: 'Pixel 9', addr: '', online: true, presence: 'online', paired: true };
const OLD = 'bb'.repeat(16);
const NEW = 'cc'.repeat(16);

function Shell() {
  return (
    <EngineProvider engine={engine}>
      <AppShell onPickFiles={async () => ['/Users/d/Documents/a.pdf']} />
    </EngineProvider>
  );
}

const active = (transferId: string, updatedAt: number): TransferSummary => ({
  transferId, peerDeviceId: device.deviceId, direction: 'out', kind: 'media',
  state: 'active', bytesDone: 1, bytesTotal: 2, itemCount: 1, updatedAt,
});

beforeEach(() => {
  jest.restoreAllMocks();
  jest.spyOn(engine, 'devices').mockResolvedValue([device]);
  jest.spyOn(engine, 'listTransfers').mockResolvedValue([]);
});

// The row must open a thread bound to THAT device, and the engine must receive
// that device id. That is the difference between a route and a no-op.
it('routes the device row into the thread for that peer', async () => {
  const send = jest.spyOn(engine, 'send').mockResolvedValue({ transferId: OLD, queued: false });
  render(<Shell />);
  fireEvent.press(await screen.findByTestId('open-' + device.deviceId));
  fireEvent.changeText(await screen.findByPlaceholderText('Or type a note'), 'hello');
  fireEvent.press(screen.getByLabelText('send'));
  await waitFor(() => expect(send).toHaveBeenCalledWith({ peerDeviceId: device.deviceId, text: 'hello' }));
});

// The picker is INJECTED. A host that supplies none leaves "Add files" absent,
// and a button wired to nothing is indistinguishable from a working one.
it('sends the paths the injected picker returned', async () => {
  const send = jest.spyOn(engine, 'send').mockResolvedValue({ transferId: OLD, queued: false });
  render(<Shell />);
  fireEvent.press(await screen.findByTestId('open-' + device.deviceId));
  fireEvent.press(await screen.findByLabelText('pick-files'));
  await waitFor(() => expect(screen.getByText('a.pdf')).toBeTruthy());
  fireEvent.press(screen.getByLabelText('send'));
  await waitFor(() =>
    expect(send).toHaveBeenCalledWith({ peerDeviceId: device.deviceId, files: ['/Users/d/Documents/a.pdf'] }),
  );
});

// Two transfers at once. Each shows its own card, and Stop cancels the id that
// was tapped.
it('shows both active transfers and cancels the one that was tapped', async () => {
  jest.spyOn(engine, 'listTransfers').mockResolvedValue([active(NEW, 6), active(OLD, 5)]);
  const cancel = jest.spyOn(engine, 'cancel').mockResolvedValue();
  render(<Shell />);
  fireEvent.press(await screen.findByTestId('open-' + device.deviceId));
  await screen.findByTestId('thread-active-' + OLD);
  expect(screen.getByTestId('thread-active-' + NEW)).toBeTruthy();
  fireEvent.press(screen.getByLabelText('thread-stop-' + OLD));
  fireEvent.press(screen.getByLabelText('confirm-stop'));
  await waitFor(() => expect(cancel).toHaveBeenCalledWith(OLD));
  expect(cancel).toHaveBeenCalledTimes(1);
});

// The send route must not grow its OWN drain: App.tsx is the single drain site
// and it waits for the engine. A second one deletes the batch twice and loses
// the bytes. SendFlow is the file that owns the picker, so a second drain
// would grow there.
it('does not drain the staged share inbox on the way to Send', () => {
  const src = readFileSync(join(__dirname, '..', 'SendFlow.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  expect(src).not.toMatch(/drainInbound/);
  expect(src).not.toMatch(/consumePendingShare/);
});

// An `onSend={() => {}}` shipped in two screens once and no test could see it.
describe('no dead onSend callback exists anywhere in the tree', () => {
  const roots = ['packages/ui/src', 'apps/mobile/src'];
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

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

