import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { DaakEvent, DeviceInfo, TransferSummary } from '@daak/core';
import { useEngine } from '../EngineContext';
import { ProgressRow } from '../components/ProgressRow';
import { Btn, Empty, Note } from '../components/ds';
import { ui } from '../theme';

const LIVE: DaakEvent['type'][] = [
  'transfer.progress',
  'transfer.item',
  'transfer.done',
  'transfer.failed',
];

const UNFINISHED = new Set(['queued', 'active', 'awaiting_ack', 'paused', 'receiving']);

/**
 * "3 item(s) from Kitchen Tablet", with the peer's NAME when the engine knows it
 * and an id prefix when it does not. A transfer row keyed on a raw device id is
 * unreadable, and the name is already in hand from devices().
 */
const labelFor = (t: TransferSummary, devices: DeviceInfo[]): string => {
  const peer = devices.find((d) => d.deviceId === t.peerDeviceId)?.name ?? t.peerDeviceId.slice(0, 8);
  return t.direction === 'in'
    ? t.itemCount + ' item(s) from ' + peer
    : t.itemCount + ' item(s) to ' + peer;
};

/**
 * EVERY transfer, not the newest one. The old app-side adapter picked a single
 * transfer and the desktop Dashboard picked the first active one, so two
 * concurrent sends left one of them invisible with no way to stop it.
 *
 * Cancel/retry are the real engine verbs, so the buttons are real. They appear
 * only for the states they apply to, and a rejected command says so on screen
 * rather than failing silently.
 */
export function TransfersScreen({ onOpen }: { onOpen?: (transferId: string) => void } = {}) {
  const engine = useEngine();
  const [all, setAll] = useState<TransferSummary[]>([]);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    void Promise.all([engine.listTransfers(), engine.devices()]).then(
      ([list, known]) => {
        setAll(list);
        setDevices(known);
      },
      () => setError('The engine did not answer with a transfer list.'),
    );
  }, [engine]);

  useEffect(() => {
    refresh();
    return engine.on((e) => {
      if (LIVE.includes(e.type)) refresh();
    });
  }, [engine, refresh]);

  const command = (t: TransferSummary, verb: 'cancel' | 'retry') => {
    setError('');
    void engine[verb](t.transferId).catch((e: unknown) =>
      setError(e instanceof Error ? e.message : verb + ' failed'),
    );
  };

  const rows = [...all].sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <View style={ui.screen}>
      <View style={ui.appbar}>
        <Text style={ui.appbarTitle}>Transfers</Text>
        <Btn label="Refresh" variant="ghost" onPress={refresh} testID="transfers-refresh" />
      </View>
      <ScrollView contentContainerStyle={ui.pad}>
        {rows.length === 0 ? (
          <Empty
            title="No transfers yet"
            body="Anything you send, and anything sent to you, shows up here while it moves."
          />
        ) : (
          rows.map((t) => (
            <ProgressRow
              key={t.transferId}
              name={labelFor(t, devices)}
              bytesDone={t.bytesDone}
              bytesTotal={t.bytesTotal}
              state={t.state}
              onCancel={UNFINISHED.has(t.state) ? () => command(t, 'cancel') : undefined}
              onRetry={t.state === 'failed' ? () => command(t, 'retry') : undefined}
              onOpen={onOpen ? () => onOpen(t.transferId) : undefined}
            />
          ))
        )}
        {error ? <Note tone="err" title="That did not work" body={error} testID="transfers-error" /> : null}
        <Note
          title="Keep both devices on this Wi-Fi"
          body="A stopped transfer is not lost. The files are still on the sending device and you can try again."
        />
      </ScrollView>
    </View>
  );
}
