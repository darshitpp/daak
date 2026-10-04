import React from 'react';
import { Text, View } from 'react-native';
import type { ItemState } from '@daak/core';
import { ui } from '../theme';

export interface ReceivedItemView {
  transferId: string;
  itemIndex: number;
  /**
   * NOT on the `transfer.item` event: TransferItemEvent (daak-ffi/src/lib.rs:73)
   * carries transfer_id/item_index/state/dest_path and nothing else. Until the
   * event grows a name field the row is labelled by index, which is true, and
   * never `item-2` dressed up as a filename.
   */
  name?: string;
  state: ItemState;
  destPath?: string;
}

/**
 * There is NO Retry button here, and that is the point.
 *
 * The prototype's receive row offers "Retry" on a failed item, which implies a
 * receiver can ask its sender to send the bytes again. Daak's protocol is
 * PUSH-ONLY: there is no message a receiver can send a sender to ask, and the
 * held bytes on disk are the exact bytes that just failed the fingerprint
 * check, so a local retry reproduces the identical mismatch. Rendering the
 * button would be offering a rescue that does not exist on the one screen a
 * user reads when a file did not arrive.
 *
 * `Engine::retry_item` is reachable from Rust and from the native modules for
 * in-process housekeeping, but it is not a user-facing affordance and nothing
 * offers it here.
 */
export function ReceivedItemRow({ item }: { item: ReceivedItemView }) {
  const label = item.name ?? `item ${item.itemIndex}`;
  return (
    <View style={ui.listRow} accessibilityRole="summary">
      <View style={ui.fill}>
        <Text style={ui.rowTitle} numberOfLines={1}>{label}</Text>
        <Text style={ui.rowSub}>{item.state}</Text>
      </View>
    </View>
  );
}
