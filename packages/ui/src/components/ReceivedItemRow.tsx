import React from 'react';
import { Pressable, Text, View } from 'react-native';
import type { ItemState } from '@daak/core';

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
 * (engine.rs:700) is real in Rust but is bound in neither the UDL nor the
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
    <View accessibilityRole="summary">
      <Text>{label}</Text>
      <Text>{item.state}</Text>
      {onRetry && item.state !== 'done' ? (
        <Pressable
          accessibilityLabel={`retry-${label}`}
          onPress={() => onRetry(item.transferId, item.itemIndex)}
        >
          <Text>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
