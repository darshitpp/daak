import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { DaakEvent, DeviceInfo } from '@daak/core';
import { useEngine } from '../EngineContext';
import { DeviceCard } from '../components/DeviceCard';
import { Avatar, Btn, Empty, Note, Section, Status, byPresence } from '../components/ds';
import { useSelfPresence } from '../state/selfPresence';
import { ui } from '../theme';

// Events that change the list, a status word, or a queue count.
const REFRESH_ON: ReadonlySet<DaakEvent['type']> = new Set<DaakEvent['type']>([
  'device.state',
  'device.discovered',
  'device.presence',
  'pairing.done',
  'pairing.revoked',
]);

function shareText(s: { fileCount: number; hasText: boolean }): string {
  const files = s.fileCount === 0 ? '' : s.fileCount === 1 ? '1 file' : s.fileCount + ' files';
  const note = s.hasText ? 'a note' : '';
  const what = files !== '' && note !== '' ? files + ' and ' + note : files + note;
  return what + (s.fileCount + (s.hasText ? 1 : 0) > 1 ? ' are' : ' is') + ' ready. Tap a device to send them.';
}

/**
 * The Devices tab (design: `devices`). A paired device opens its thread, also
 * when it is offline, because the engine queues the send. Nothing on this
 * screen sends. Unpair is in Settings.
 */
export function DashboardScreen({ onOpenThread, onPair, onCheckConnection, pendingShare }: {
  onOpenThread?: (d: DeviceInfo) => void;
  onPair?: () => void;
  /** The "A device you paired isn't showing?" link. The host owns the check. */
  onCheckConnection?: () => void;
  pendingShare?: { fileCount: number; hasText: boolean } | null;
} = {}) {
  const engine = useEngine();
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [selfName, setSelfName] = useState('This device');
  const [error, setError] = useState('');
  const [queueDepth, setQueueDepth] = useState<Record<string, number>>({});
  // The value the user chose in Settings (design: `#this-device-status`).
  const self = useSelfPresence();

  const refresh = useCallback(() => {
    void engine.devices().then(
      (list) => {
        setDevices(list);
        setError('');
      },
      (e: unknown) => setError(e instanceof Error ? e.message : 'the engine did not answer with a device list'),
    );
    // The queue count survives a relaunch only in the database. Count the
    // queued outbound transfers for each peer. A failed read keeps the old counts.
    void engine.listTransfers({ state: 'queued' }).then(
      (rows) => {
        const counts: Record<string, number> = {};
        for (const t of rows) if (t.direction === 'out' && t.state === 'queued') counts[t.peerDeviceId] = (counts[t.peerDeviceId] ?? 0) + 1;
        setQueueDepth(counts);
      },
      () => {},
    );
  }, [engine]);

  useEffect(() => {
    refresh();
    void engine.selfProfile().then((p) => setSelfName(p.name), () => {});
    return engine.on((e) => {
      if (e.type === 'outbox.queued') setQueueDepth((q) => ({ ...q, [e.deviceId]: e.queued }));
      if (REFRESH_ON.has(e.type)) refresh();
    });
  }, [engine, refresh]);

  const paired = devices.filter((d) => d.paired === true).sort(byPresence);
  const nearby = devices.filter((d) => d.paired !== true);

  return (
    <View style={ui.screen}>
      <View style={ui.appbar}>
        <Text style={ui.appbarTitle} accessibilityRole="header">Devices</Text>
      </View>
      <ScrollView contentContainerStyle={ui.pad}>
        <Text style={ui.lead}>
          Everything on your Wi-Fi. Tap a device you've paired with to open your conversation, or pair a new one.
        </Text>
        {pendingShare ? (
          <Note tone="ok" title="Pick a device for what you shared" body={shareText(pendingShare)} testID="pending-share" />
        ) : null}
        {error ? <Note tone="err" title="No device list" body={error} testID="devices-error" /> : null}

        <Section title="This device">
          <View style={ui.listRow}>
            <Avatar letter={selfName} />
            <View style={ui.fill}>
              <Text style={ui.rowTitle} numberOfLines={1}>{selfName}</Text>
              <View testID="this-device-status">
                {self === 'online' ? <Status tone="ok" label="On this network" /> : <Status tone="warn" label="Away" />}
              </View>
            </View>
          </View>
        </Section>

        <Section title="Your devices">
          {paired.length === 0 ? (
            <Empty
              title="No paired devices yet"
              body="Pair a device on your Wi-Fi and it will show up here."
              action={onPair ? <Btn label="Pair a device" onPress={onPair} testID="pair-a-device-empty" /> : undefined}
            />
          ) : (
            <View style={ui.list}>
              {paired.map((d) => (
                <DeviceCard key={d.deviceId} device={d} queued={queueDepth[d.deviceId] ?? 0} onOpen={onOpenThread} />
              ))}
            </View>
          )}
        </Section>

        {nearby.length > 0 ? (
          <Section title="Nearby, not paired yet">
            <View style={ui.list}>
              {nearby.map((d) => (
                <DeviceCard key={d.deviceId} device={d} onPair={onPair} />
              ))}
            </View>
          </Section>
        ) : null}

        {onPair ? <Btn label="Pair a new device" variant="primary" block onPress={onPair} testID="pair-a-device" /> : null}
        {onCheckConnection ? (
          <Btn
            variant="quiet"
            block
            label="A device you paired isn't showing? See what to check"
            testID="devices-check-connection"
            onPress={onCheckConnection}
          />
        ) : null}
      </ScrollView>
    </View>
  );
}

