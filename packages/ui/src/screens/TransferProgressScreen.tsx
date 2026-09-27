import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import type { ItemState, TransferSummary } from '@daak/core';
import { useEngine } from '../EngineContext';
import { ProgressRow } from '../components/ProgressRow';

export function TransferProgressScreen({ transferId }: { transferId: string }) {
  const engine = useEngine();
  const [summary, setSummary] = useState<TransferSummary | null>(null);
  const [itemStates, setItemStates] = useState<ItemState[]>([]);

  useEffect(() => {
    void engine.listTransfers().then((all) => {
      setSummary(all.find((t) => t.transferId === transferId) ?? null);
    });
    return engine.on((e) => {
      if (e.type === 'transfer.progress' && e.transferId === transferId) {
        setSummary((prev) => prev && { ...prev, bytesDone: e.bytesDone, bytesTotal: e.bytesTotal });
      }
      if (e.type === 'transfer.item' && e.transferId === transferId) {
        setItemStates((prev) => {
          const next = [...prev];
          next[e.itemIndex] = e.state;
          return next;
        });
      }
    });
  }, [engine, transferId]);

  return (
    <View>
      {summary ? (
        <ProgressRow name={summary.kind} bytesDone={summary.bytesDone} bytesTotal={summary.bytesTotal}
          state={summary.state} />
      ) : null}
      {itemStates.map((s, i) => s ? <ProgressRow key={i} name={`item ${i}`} bytesDone={0} bytesTotal={0} state={s} /> : null)}
    </View>
  );
}
