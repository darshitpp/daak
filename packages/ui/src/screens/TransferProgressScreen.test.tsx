import React from 'react';
import { render, screen, act } from '@testing-library/react-native';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { DaakEngine, DaakEvent } from '@daak/core';
import { EngineProvider } from '../EngineContext';
import { fakeEngine } from '../testing/fakeEngine';
import { TransferProgressScreen } from './TransferProgressScreen';

const transferId = 'bb'.repeat(16);

function drive(engine: DaakEngine, e: DaakEvent) {
  const h = (engine as unknown as { __handlers: Set<(e: DaakEvent) => void> }).__handlers;
  act(() => { h.forEach((cb) => cb(e)); });
}

describe('TransferProgressScreen item rows', () => {
  it('renders an inbound item row labelled by index and state', () => {
    const engine = fakeEngine();
    render(<EngineProvider engine={engine}><TransferProgressScreen transferId={transferId} /></EngineProvider>);
    drive(engine, { type: 'transfer.item', transferId, itemIndex: 1, state: 'quarantined' });
    // Index + state, never a fabricated filename: the event has no name
    // (TransferItemEvent, daak-ffi/src/lib.rs:73-78).
    expect(screen.getByText('item 1')).toBeTruthy();
    expect(screen.getByText('quarantined')).toBeTruthy();
  });

  it('updates a row in place as the state advances', () => {
    const engine = fakeEngine();
    render(<EngineProvider engine={engine}><TransferProgressScreen transferId={transferId} /></EngineProvider>);
    drive(engine, { type: 'transfer.item', transferId, itemIndex: 1, state: 'receiving' });
    drive(engine, { type: 'transfer.item', transferId, itemIndex: 1, state: 'verifying' });
    expect(screen.getByText('verifying')).toBeTruthy();
    expect(screen.queryByText('receiving')).toBeNull();
    expect(screen.getAllByText('item 1')).toHaveLength(1);
  });

  it('ignores items belonging to another transfer', () => {
    const engine = fakeEngine();
    render(<EngineProvider engine={engine}><TransferProgressScreen transferId={transferId} /></EngineProvider>);
    drive(engine, { type: 'transfer.item', transferId: 'cc'.repeat(16), itemIndex: 0, state: 'done' });
    expect(screen.queryByText('item 0')).toBeNull();
  });

  // The item row used to be a ProgressRow with bytesDone=0/bytesTotal=0, which
  // renders a hardcoded "0%" -- a progress bar frozen at zero on a file that is
  // actively moving, for every item, forever (R16). The item row shows state
  // only, because `transfer.item` carries no byte counts.
  it('never fabricates a 0% for an item, because the event carries no byte counts', () => {
    const engine = fakeEngine();
    render(<EngineProvider engine={engine}><TransferProgressScreen transferId={transferId} /></EngineProvider>);
    drive(engine, { type: 'transfer.item', transferId, itemIndex: 0, state: 'receiving' });
    expect(screen.getByText('item 0')).toBeTruthy();
    expect(screen.queryByText('0%')).toBeNull();
  });

  // R115(b): retryItem is not on the frozen surface, so the screen must render
  // the row WITHOUT a Retry button rather than passing a callback that would
  // call nothing. A Retry control that appears in the app and does nothing is
  // worse than its absence.
  it('offers no Retry, because the frozen engine cannot retry an item', () => {
    const engine = fakeEngine();
    render(<EngineProvider engine={engine}><TransferProgressScreen transferId={transferId} /></EngineProvider>);
    drive(engine, { type: 'transfer.item', transferId, itemIndex: 1, state: 'quarantined' });
    expect(screen.queryByText('Retry')).toBeNull();
  });
});

// R116, now closed on the emit side: daak-core HAS an EngineEvent::TransferItem
// variant and daak-ffi HAS a to_ffi_event arm, so `transfer.item` can now reach
// JS. What replaced the old "the gap still exists" pin is the contract that
// actually matters to this screen: the FFI JSON and the TS union must agree, or
// the row renders off a shape nothing sends.
describe('the transfer.item wire contract this row depends on', () => {
  const repo = join(__dirname, '..', '..', '..', '..');
  const read = (p: string) => readFileSync(join(repo, p), 'utf8');

  it('daak-core now HAS the EngineEvent::TransferItem variant', () => {
    const src = read('crates/daak-core/src/engine.rs');
    // The variant must be declared INSIDE the enum body, and the body is found
    // by brace-matching from the enum's own header -- NOT by slicing to some
    // unrelated later declaration.
    //
    // A slice(start, end).toContain(x) is monotone in the region: widening the
    // region can only ever make containment MORE likely to pass, so `slice(0,)`
    // stays green and the start bound is decoration. Brace-matching is not: if
    // the header is not found the search for `{` latches onto some earlier brace
    // in the file and the region closes before the variant, so a wrong start
    // bound fails loudly instead of silently succeeding (the R86/R95 lesson).
    const header = src.indexOf('pub enum EngineEvent');
    expect(header).toBeGreaterThan(-1);
    const open = src.indexOf('{', header);
    expect(open).toBeGreaterThan(header);
    let depth = 0;
    let close = -1;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) { close = i; break; }
    }
    // A body that never closes means the region ran to EOF and would satisfy
    // any containment assertion from unrelated code.
    expect(close).toBeGreaterThan(open);
    const decl = src.indexOf('TransferItem {');
    expect(decl).toBeGreaterThan(open);
    expect(decl).toBeLessThan(close);
  });

  it('the FFI JSON and the TS union agree on the same four keys', () => {
    // The four fields both bridges carry. If one side grows or renames a key,
    // the other becomes a lie and this fails.
    const json = read('crates/daak-ffi/src/lib.rs');
    const itemArm = json.slice(json.indexOf('FfiEvent::TransferItem { data } => serde_json::json!'));
    const jsonKeys = ['type', 'transferId', 'itemIndex', 'state', 'destPath'];
    for (const k of jsonKeys) expect(itemArm).toContain(`"${k}"`);

    // DaemonClient decodes the daemon's IpcEvent into the SAME TS shape, so the
    // camelCase keys it reads must be exactly this set.
    const daemon = read('packages/core/src/engine/DaemonClient.ts');
    const arm = daemon.slice(daemon.indexOf(`case 'TransferItem':`));
    for (const k of ['transferId', 'itemIndex', 'state', 'destPath']) {
      expect(arm.slice(0, arm.indexOf('}'))).toContain(`${k}:`);
    }
  });

  it('the TS union member carries the same four fields', () => {
    const types = read('packages/core/src/engine/types.ts');
    const line = types.split('\n').find((l) => l.includes("type: 'transfer.item'"))!;
    for (const k of ['transferId', 'itemIndex', 'state', 'destPath']) {
      expect(line).toContain(`${k}`);
    }
  });
});
