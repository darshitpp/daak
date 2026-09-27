import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { TransferProgressScreen, useEngine } from '@daak/ui';

/**
 * The app-side half of the transfers tab (R100: the shell stays presentational).
 *
 * TransferProgressScreen takes a transferId and nothing else, so the one thing
 * this has to decide is WHICH transfer to show. Newest-updated wins, because
 * the engine emits `transfer.item` against whichever transfer is live and there
 * is no transfer router to speak of.
 * ponytail: newest-transfer-wins; a real router is owed only when two transfers
 * can be on one screen at once.
 */
export function TransfersFlow() {
  const engine = useEngine();
  const [transferId, setTransferId] = useState('');

  const pick = () =>
    void engine.listTransfers().then((all) => {
      const newest = [...all].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      setTransferId(newest?.transferId ?? '');
    });

  useEffect(() => {
    pick();
    return engine.on((e) => {
      if (e.type === 'transfer.progress' || e.type === 'transfer.item') pick();
    });
    // pick is stable for the life of the component; the engine is the only dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  if (transferId === '') {
    return (
      <View>
        <Text>No transfers yet</Text>
        <Pressable accessibilityLabel="transfers-refresh" onPress={pick}>
          <Text>Refresh</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View>
      <TransferProgressScreen transferId={transferId} />
      <Pressable accessibilityLabel="transfers-refresh" onPress={pick}>
        <Text>Refresh</Text>
      </Pressable>
    </View>
  );
}
