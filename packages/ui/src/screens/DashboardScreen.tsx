import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { DaakEvent, DeviceInfo } from '@daak/core';
import { useEngine } from '../EngineContext';
import { DeviceCard } from '../components/DeviceCard';
import { whenLabel } from '../components/Bubble';
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
  // A new send or receive changes the row line and its time.
  'transfer.done',
  'transfer.item',
  'inbox.received',
]);

// A presence flap arrives as many events in a burst. One read after the burst
// is enough, so the refresh waits this long.
const REFRESH_DEBOUNCE_MS = 300;

/** The design `contact-last` and `contact-when` of one device row. */
type RowFacts = { lastItem: string; when: string };

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
  const [rows, setRows] = useState<Record<string, RowFacts>>({});
  // The value the user chose in Settings (design: `#this-device-status`).
  const self = useSelfPresence();

  // Only the newest refresh may write state. `alive` stops a write after
  // unmount. `timer` holds the pending debounce.
  const generation = useRef(0);
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => {
    const gen = ++generation.current;
    const stale = () => gen !== generation.current || !alive.current;
    void engine.devices().then(
      (list) => {
        if (stale()) return;
        setDevices(list);
        setError('');
        // Design renderDevices: each paired row shows the newest item and its
        // time. One limit-1 read for each paired device. The page is bounded,
        // so the cost is one small read for each paired device on each load.
        void Promise.all(
          list
            .filter((d) => d.paired === true)
            .map((d) =>
              engine.listThread(d.deviceId, { limit: 1 }).then(
                (page) => {
                  const last = page.items[page.items.length - 1];
                  const facts: RowFacts =
                    last === undefined
                      ? { lastItem: 'No items yet', when: '' }
                      : // A text item carries no name. "A note" is the honest
                        // word for it; the design shows file names only.
                        { lastItem: last.name ?? 'A note', when: whenLabel(last.at) };
                  return [d.deviceId, facts] as const;
                },
                // A failed read returns null. The caller then keeps the row's
                // previous line and time, and the row stays visible.
                () => null,
              ),
            ),
        ).then((read) => {
          if (stale()) return;
          // Start from the last answer, so a row whose read rejected keeps
          // its previous line and time.
          setRows((prev) => {
            const next = { ...prev };
            for (const row of read) if (row !== null) next[row[0]] = row[1];
            return next;
          });
        });
      },
      (e: unknown) => {
        if (stale()) return;
        setError(e instanceof Error ? e.message : 'the engine did not answer with a device list');
      },
    );
    // The queue count survives a relaunch only in the database. Count the
    // queued outbound transfers for each peer. A failed read keeps the old counts.
    void engine.listTransfers({ state: 'queued' }).then(
      (rows) => {
        if (stale()) return;
        const counts: Record<string, number> = {};
        for (const t of rows) if (t.direction === 'out' && t.state === 'queued') counts[t.peerDeviceId] = (counts[t.peerDeviceId] ?? 0) + 1;
        setQueueDepth(counts);
      },
      () => {},
    );
  }, [engine]);

  const scheduleRefresh = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      refresh();
    }, REFRESH_DEBOUNCE_MS);
  }, [refresh]);

  useEffect(() => {
    alive.current = true;
    refresh();
    void engine.selfProfile().then((p) => { if (alive.current) setSelfName(p.name); }, () => {});
    const off = engine.on((e) => {
      if (e.type === 'outbox.queued') setQueueDepth((q) => ({ ...q, [e.deviceId]: e.queued }));
      if (REFRESH_ON.has(e.type)) scheduleRefresh();
    });
    return () => {
      alive.current = false;
      if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
      off();
    };
  }, [engine, refresh, scheduleRefresh]);

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
                <DeviceCard
                  key={d.deviceId}
                  device={d}
                  queued={queueDepth[d.deviceId] ?? 0}
                  lastItem={rows[d.deviceId]?.lastItem}
                  when={rows[d.deviceId]?.when}
                  onOpen={onOpenThread}
                />
              ))}
            </View>
          )}
        </Section>

        {nearby.length > 0 ? (
          <Section title="Nearby, not paired yet" testID="nearby-section">
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

