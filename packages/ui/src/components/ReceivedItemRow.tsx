import React from 'react';
import { Text, View } from 'react-native';
import type { ItemState } from '@daak/core';
import { ui } from '../theme';
import { Btn } from './ds';

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
 * `onRetry` is OPTIONAL, and that is the honest part: `Engine::retry_item`
 * (engine.rs:720) is real in Rust but is bound in neither the UDL nor the
 * IpcRequest enum (R115(b)), so no caller today can pass one. A required
 * callback would force every call site to hand a function wired to nothing.
 * Retry is rendered only when retry is real.
 */
export function ReceivedItemRow({ item, onRetry }: {
  item: ReceivedItemView;
  onRetry?: (transferId: string, itemIndex: number) => void;
}) {
  const label = item.name ?? `item ${item.itemIndex}`;
  return (
    <View style={ui.listRow} accessibilityRole="summary">
      <View style={ui.fill}>
        <Text style={ui.rowTitle} numberOfLines={1}>{label}</Text>
        <Text style={ui.rowSub}>{item.state}</Text>
      </View>
      {onRetry && item.state !== 'done' ? (
        <Btn label="Retry" onPress={() => onRetry(item.transferId, item.itemIndex)} testID={`retry-${label}`} />
      ) : null}
    </View>
  );
}
