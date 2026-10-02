import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import type { TransferSummary } from '@daak/core';
import { useEngine } from '../EngineContext';
import { ProgressRow } from '../components/ProgressRow';
import { ReceivedItemRow, type ReceivedItemView } from '../components/ReceivedItemRow';
import { ui } from '../theme';

/**
 * One transfer, with its item rows. TransfersScreen is the list; this is the
 * per-transfer detail the engine's transfer.item events address, and it is what
 * the old I1 reachability pin kept alive.
 */
export function TransferProgressScreen({ transferId }: { transferId: string }) {
  const engine = useEngine();
  const [summary, setSummary] = useState<TransferSummary | null>(null);
  const [items, setItems] = useState<ReceivedItemView[]>([]);

  useEffect(() => {
    void engine.listTransfers().then((all) => {
      setSummary(all.find((t) => t.transferId === transferId) ?? null);
    });
    return engine.on((e) => {
      if (e.type === 'transfer.progress' && e.transferId === transferId) {
        setSummary((prev) => prev && { ...prev, bytesDone: e.bytesDone, bytesTotal: e.bytesTotal });
      }
      if (e.type === 'transfer.item' && e.transferId === transferId) {
        setItems((prev) => {
          const rest = prev.filter((i) => i.itemIndex !== e.itemIndex);
          return [...rest, { transferId: e.transferId, itemIndex: e.itemIndex, state: e.state }];
        });
      }
    });
  }, [engine, transferId]);

  return (
    <View style={ui.stack}>
      {summary ? (
        <ProgressRow
          name={summary.kind}
          bytesDone={summary.bytesDone}
          bytesTotal={summary.bytesTotal}
          state={summary.state}
          onCancel={summary.state === 'active' || summary.state === 'receiving'
            ? () => void engine.cancel(summary.transferId)
            : undefined}
          onRetry={summary.state === 'failed' ? () => void engine.retry(summary.transferId) : undefined}
        />
      ) : null}
      {/*
        NO onRetry: `Engine::retry_item` is real in Rust (engine.rs:720) but is
        bound in neither the UDL nor the IpcRequest enum, so there is no call to
        make. ReceivedItemRow hides Retry when no callback is supplied, which is
        the honest rendering of "retry is not reachable yet" (R115(b)).

        NO ProgressRow either: it takes byte counts, and `transfer.item` carries
        none, so it would render a permanent "0%" on every moving file (R16).
      */}
      {items.map((i) => (
        <ReceivedItemRow key={i.itemIndex} item={i} />
      ))}
    </View>
  );
}
