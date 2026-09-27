import React from 'react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ItemState } from '@daak/core';
import { ReceivedItemRow } from './ReceivedItemRow';

const item = { transferId: 't1', itemIndex: 2, state: 'quarantined' as ItemState };

describe('ReceivedItemRow', () => {
  // The engine only ever writes 'done' and 'quarantined' for an inbound item
  // (crates/daak-core/src/transfer/receiver.rs:334-345) and retry_item re-arms
  // it to 'pending' (engine.rs:1030), so every one of the six frozen states is
  // renderable and none of them may be silently dropped.
  it('renders every frozen item state', () => {
    const states: ItemState[] = ['pending', 'receiving', 'verifying', 'done', 'failed', 'quarantined'];
    for (const state of states) {
      const { unmount } = render(<ReceivedItemRow item={{ ...item, state }} />);
      expect(screen.getByText(state)).toBeTruthy();
      unmount();
    }
  });

  // The event carries no name (TransferItemEvent, daak-ffi/src/lib.rs:73-78),
  // so the row shows the index honestly rather than a fabricated filename.
  it('labels the row by index, not by an invented name', () => {
    render(<ReceivedItemRow item={item} />);
    expect(screen.getByText('item 2')).toBeTruthy();
  });

  it('retries the exact item', () => {
    const onRetry = jest.fn();
    render(<ReceivedItemRow item={item} onRetry={onRetry} />);
    fireEvent.press(screen.getByLabelText('retry-item 2'));
    expect(onRetry).toHaveBeenCalledWith('t1', 2);
  });

  // No retryItem on the frozen surface (R115(b)), so a caller that cannot retry
  // must not be shown a Retry button: it would be a control wired to nothing.
  it('offers no Retry when the caller cannot retry', () => {
    render(<ReceivedItemRow item={item} />);
    expect(screen.queryByLabelText('retry-item 2')).toBeNull();
  });

  it('offers no Retry once the item is done', () => {
    render(<ReceivedItemRow item={{ ...item, state: 'done' }} onRetry={jest.fn()} />);
    expect(screen.queryByLabelText('retry-item 2')).toBeNull();
  });
});

// R118: 'received' is NOT a transfer_items.state (spec 4.2) and the engine
// never writes it. Pinned against the SOURCE, both the shared type and this
// component, so adding it fails here rather than reaching a user's screen.
describe('item-state vocabulary', () => {
  const here = __dirname;
  const read = (p: string) => readFileSync(join(here, p), 'utf8');
  const FROZEN = ['pending', 'receiving', 'verifying', 'done', 'failed', 'quarantined'];

  it('is exactly the six frozen states in @daak/core', () => {
    const line = read('../../../core/src/engine/types.ts')
      .split('\n')
      .find((l) => l.includes('export type ItemState'));
    expect(line).toBeDefined();
    for (const s of FROZEN) expect(line).toContain(`'${s}'`);
    expect(line).not.toContain('received');
  });

  it('contains no stray item state in ReceivedItemRow', () => {
    const src = read('./ReceivedItemRow.tsx');
    expect(src).not.toMatch(/['"]received['"]/);
  });
});
