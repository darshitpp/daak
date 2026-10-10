import React, { useEffect, useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import type { InboxEntry, QuarantineReport } from '@daak/core';
import { useEngine } from '../EngineContext';
import { Avatar, Btn, Empty, Note, Section } from '../components/ds';
import { colors, ui } from '../theme';
import { humanBytes, senderLabel } from './quarantine-facts';

/**
 * R42l: the engine's `receivedAt` is SECONDS, the value SQLite holds, and the
 * inbox printed a 1970 date because this read it as milliseconds. The
 * held-back list already converts (`quarantine-facts.arrivedAt`), so one of the
 * two was always wrong. Seconds is the engine's unit; the conversion belongs
 * here, at the one place the value becomes text. `toLocaleString` then renders
 * it in the DEVICE's timezone, which is what a reader expects.
 */
const when = (seconds: number): string =>
  seconds > 0 ? new Date(seconds * 1000).toLocaleString() : 'just now';

import type { InboxActions } from '../inbox-actions';

export type { InboxActions };

export function HistoryScreen({
  actions,
  onOpenHeld,
}: {
  actions?: InboxActions;
  /**
   * Opens one held-back item. A CALLBACK, not a route inside this screen: the
   * detail is full-screen with no tab bar, which is the shell's decision and
   * the same one it makes for a transfer detail and for pairing.
   */
  onOpenHeld?: (r: QuarantineReport) => void;
} = {}) {
  const engine = useEngine();
  const [inbox, setInbox] = useState<InboxEntry[]>([]);
  const [held, setHeld] = useState<QuarantineReport[]>([]);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [noReveal, setNoReveal] = useState(false);
  // R42j: the sender's NAME, keyed by device id. The inbox row carries only
  // `peerDeviceId`; the name lives on the device map, which is seeded from the
  // pairings at start, so a paired sender resolves without a store change.
  const [names, setNames] = useState<Record<string, string>>({});

  const open = (path: string) =>
    // NOT .then(setNoReveal): that hands the resolved boolean to the setter,
    // so a platform that DID open the file (true) would light the warning.
    void actions?.open?.(path).then((opened) => setNoReveal(!opened), () => setNoReveal(true));

  useEffect(() => {
    // Held-back items are listed SEPARATELY from the inbox, and deliberately
    // not merged into it: an inbox row is a delivered payload, and a held item
    // was NOT delivered. Folding them together would show a file the user never
    // received as though it had arrived.
    //
    // The held list REFRESHES on any transfer.item event, because that is what
    // the engine emits when a held item is deleted or newly quarantined -- and a
    // stale row here would offer to open a file that is gone.
    const refreshHeld = () =>
      void engine.listQuarantineReports().then(
        (list) => setHeld(list),
        // A daemon that refuses this read must NOT take the inbox down with it:
        // the inbox is the primary surface and still works.
        () => setHeld([]),
      );
    const refresh = () =>
      void engine.listInbox().then(
        (list) => {
          setInbox(list);
          setError('');
        },
        (e: unknown) => setError(e instanceof Error ? e.message : 'the engine did not answer with an inbox'),
      );
    refresh();
    refreshHeld();
    const refreshNames = () =>
      void engine.devices().then(
        (list) => setNames(Object.fromEntries(list.map((d) => [d.deviceId, d.name]))),
        // A device list we cannot read must not blank the sender column; the
        // row falls back to the device id, which is a fact.
        () => {},
      );
    refreshNames();
    const off = engine.on((e) => {
      if (e.type === 'inbox.received') setInbox((prev) => [e.payload, ...prev]);
      if (e.type === 'transfer.item') refreshHeld();
      if (e.type === 'device.discovered' || e.type === 'device.state') refreshNames();
    });
    return off;
  }, [engine]);

  // The search box filters what the engine already gave us. There is no
  // server-side search verb and none is needed: an inbox is one device's list.
  const needle = q.trim().toLowerCase();
  const shown =
    needle === ''
      ? inbox
      : inbox.filter(
          (i) => i.summary.toLowerCase().includes(needle) || i.peerDeviceId.toLowerCase().includes(needle),
        );

  return (
    <View style={ui.screen}>
      <View style={ui.appbar}>
        <Text style={ui.appbarTitle}>Inbox</Text>
      </View>
      <ScrollView contentContainerStyle={ui.pad} keyboardShouldPersistTaps="handled">
        <View style={ui.stackSm}>
          <Text style={ui.label}>Search what arrived</Text>
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder="Name of a file or device"
            placeholderTextColor={colors.meta}
            autoCorrect={false}
            style={ui.search}
          />
        </View>
        <Section title={'Received (' + shown.length + ')'}>
          {error ? <Note tone="err" title="No inbox" body={error} testID="inbox-error" /> : null}
          {shown.length === 0 ? (
            <Empty
              title={needle === '' ? 'Your Inbox is empty' : 'Nothing matches that'}
              body={
                needle === ''
                  ? 'Files sent to this device land here. Nothing is stored in the cloud.'
                  : 'Nothing that arrived has that word in it. Try one word, like a device name.'
              }
              action={needle === '' ? undefined : <Btn label="Clear search" onPress={() => setQ('')} />}
            />
          ) : (
            <View style={ui.list}>
              {shown.map((i) => (
                <View key={i.payloadId} style={ui.listRow}>
                  <Avatar letter={i.summary} />
                  <View style={ui.fill}>
                    <Text style={ui.rowTitle} numberOfLines={1}>
                      {i.summary}
                    </Text>
                    <Text style={ui.rowSub} numberOfLines={1}>
                      {(names[i.peerDeviceId] ?? 'Device ' + i.peerDeviceId.slice(0, 8)) + ' · ' + i.itemCount + ' item(s), ' + when(i.receivedAt)}
                    </Text>
                  </View>
                  <View style={ui.row}>
                    {actions?.copy && i.kind === 'text' ? (
                      <Btn label="Copy" onPress={() => actions.copy?.(i.summary)} testID={'copy-' + i.payloadId} />
                    ) : null}
                    {actions?.open && i.savedPaths !== null && i.savedPaths.length > 0 ? (
                      <Btn label="Show" onPress={() => open(i.savedPaths?.[0] ?? '')} testID={'open-' + i.payloadId} />
                    ) : null}
                    {actions?.share && i.savedPaths !== null && i.savedPaths.length > 0 ? (
                      <Btn label="Share" variant="ghost" onPress={() => actions.share?.(i.savedPaths ?? [])} testID={'share-' + i.payloadId} />
                    ) : null}
                  </View>
                </View>
              ))}
            </View>
          )}
        </Section>
        {held.length === 0 ? null : (
          <Section title={'Held back (' + held.length + ')'}>
            <Text style={ui.hint}>
              These arrived but did not pass their fingerprint check, so Daak never
              opened them. They are not in the list above.
            </Text>
            <View style={ui.list}>
              {held.map((r) => (
                <View key={r.transferId + ':' + r.itemIndex} style={ui.listRow}>
                  <Avatar letter={r.name ?? '?'} />
                  <View style={ui.fill}>
                    <Text style={ui.rowTitle} numberOfLines={1}>
                      {r.name ?? 'Held-back file'}
                    </Text>
                    <Text style={ui.rowSub} numberOfLines={1}>
                      {senderLabel(r) + (r.size === null ? '' : ' · ' + humanBytes(r.size))}
                    </Text>
                  </View>
                  {onOpenHeld ? (
                    <Btn
                      label="See why"
                      onPress={() => onOpenHeld(r)}
                      testID={'held-' + r.transferId + '-' + r.itemIndex}
                    />
                  ) : null}
                </View>
              ))}
            </View>
          </Section>
        )}
        <Note
          title="Arrived on this device only"
          body="Only one device reads what you send. Nothing here was opened anywhere else."
        />
        {noReveal ? (
          <Note
            tone="warn"
            title="This device cannot show files"
            body="Revealing a file in place is not available here. Use Share to send it somewhere else."
            testID="inbox-no-reveal"
          />
        ) : null}
      </ScrollView>
    </View>
  );
}
