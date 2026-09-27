import React from 'react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { DaakEvent } from '@daak/core';
import type { DeviceInfo } from '@daak/core';
import { AppShell, EngineProvider, fakeEngine } from '@daak/ui';
import { SendFlow, useSendPeer } from '../SendFlow';
import { TransfersFlow } from '../TransfersFlow';

// M1 + I1, the app half. These drive the REAL shell, so they fail if AppShell
// stops threading the slot or the tab goes away -- the same reachability
// discipline pairingFlow.test.tsx applies to the pair slot.
function Shell({ onSend, composer }: { onSend?: (d: DeviceInfo) => void; composer?: React.ReactNode }) {
  return (
    <EngineProvider engine={engine}>
      <AppShell onSend={onSend} composer={composer} transfers={<TransfersFlow />} />
    </EngineProvider>
  );
}

const engine = fakeEngine();
const device = { deviceId: 'aa'.repeat(16), name: 'Pixel 9', addr: '192.168.1.9:40001', online: true };
const TRANSFER_ID = 'bb'.repeat(16);

function drive(e: DaakEvent) {
  const h = (engine as unknown as { __handlers: Set<(e: DaakEvent) => void> }).__handlers;
  act(() => { h.forEach((cb) => cb(e)); });
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

describe('the Send button routes to the composer (M1)', () => {
  it('opens a real composer for the tapped peer and reaches engine.send', async () => {
    const send = jest.spyOn(engine, 'send').mockResolvedValue({ transferId: 'bb'.repeat(16), queued: true });
    function App() {
      const [peer, open, close] = useSendPeer();
      return <Shell onSend={open} composer={<SendFlow peer={peer} onCancel={close} />} />;
    }
    render(<App />);

    // Tapping Send must mount a composer bound to THAT device, not a no-op.
    fireEvent.press(await screen.findByLabelText(`send-to-${device.deviceId}`));
    const field = await screen.findByPlaceholderText('Message');
    fireEvent.changeText(field, 'hello');
    fireEvent.press(screen.getByLabelText('send'));
    await waitFor(() => expect(send).toHaveBeenCalledWith({ peerDeviceId: device.deviceId, text: 'hello', files: [] }));

    // And Cancel closes it again, so the route is not a trap.
    fireEvent.press(screen.getByLabelText('composer-cancel'));
    await waitFor(() => expect(screen.queryByPlaceholderText('Message')).toBeNull());
  });

  // R22 stands: the composer route must not become a mount-time drain. A
  // staged share is all-or-nothing natively and nothing routes a file arm yet.
  it('does not drain the staged share inbox on the way to the composer', () => {
    // Comments stripped first: the R86/R95 lesson is that a source pin which
    // can be satisfied by PROSE is decoration, and this file's own comment
    // names drainInbound while saying the opposite.
    const src = readFileSync(join(__dirname, '..', 'SendFlow.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/drainInbound/);
    expect(src).not.toMatch(/consumePendingShare/);
  });
});

describe('the transfers tab shows real transfer.item rows (I1)', () => {
  it('renders an item row from a live transfer.item event', async () => {
    render(<Shell />);
    fireEvent.press(screen.getByText('transfers'));
    // Wait for the flow to resolve a transfer, THEN push the real event. The
    // event carries no transferId the screen filters on, so the test drives the
    // same one listTransfers returned.
    await waitFor(() => expect(screen.getByText('media')).toBeTruthy());
    drive({ type: 'transfer.item', transferId: TRANSFER_ID, itemIndex: 1, state: 'quarantined' });
    expect(screen.getByText('item 1')).toBeTruthy();
    expect(screen.getByText('quarantined')).toBeTruthy();
  });

  it('says so plainly when the engine has no transfers', async () => {
    jest.spyOn(engine, 'listTransfers').mockResolvedValue([]);
    render(<Shell />);
    fireEvent.press(screen.getByText('transfers'));
    await waitFor(() => expect(screen.getByText('No transfers yet')).toBeTruthy());
  });
});

// The source-level half of M1. `onSend={() => {}}` shipped in two screens and
// no test could see it: DeviceCard's own test passes a real jest.fn(), so a
// no-op at the call site was invisible. Comments are stripped first (R95) and
// the assert is over the whole source tree, so it goes red the moment the
// dead callback comes back anywhere.
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
