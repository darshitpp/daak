import React, { useEffect, useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import type { InboxEntry } from '@daak/core';
import { useEngine } from '../EngineContext';
import { Avatar, Btn, Empty, Note, Section } from '../components/ds';
import { colors, ui } from '../theme';

const when = (ms: number): string => (ms > 0 ? new Date(ms).toLocaleString() : 'just now');

/**
 * The prototype's per-row sheet has two verbs. They are INJECTED, like the
 * file picker: "show in folder" is a different native call on every platform
 * (Android opens a viewer through its FileProvider, iOS deliberately has no
 * reveal at all, macOS has none either) and the share sheet is a TurboModule
 * packages/ui must not import. A row renders a verb only when the host
 * supplied it and the entry actually saved files -- a button wired to nothing
 * is worse than no button. `open` answers whether the OS actually opened it:
 * reveal is a no-op on iOS by design (R41), and a button that silently does
 * nothing there is the failure the user would report.
 */
export interface InboxActions {
  open?: (path: string) => Promise<boolean>;
  share?: (paths: string[]) => void;
}

export function HistoryScreen({ actions }: { actions?: InboxActions } = {}) {
  const engine = useEngine();
  const [inbox, setInbox] = useState<InboxEntry[]>([]);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [noReveal, setNoReveal] = useState(false);

  const open = (path: string) =>
    // NOT .then(setNoReveal): that hands the resolved boolean to the setter,
    // so a platform that DID open the file (true) would light the warning.
    void actions?.open?.(path).then((opened) => setNoReveal(!opened), () => setNoReveal(true));

  useEffect(() => {
    const refresh = () =>
      void engine.listInbox().then(
        (list) => {
          setInbox(list);
          setError('');
        },
        (e: unknown) => setError(e instanceof Error ? e.message : 'the engine did not answer with an inbox'),
      );
    refresh();
    return engine.on((e) => {
      if (e.type === 'inbox.received') setInbox((prev) => [e.payload, ...prev]);
    });
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
                      {i.itemCount + ' item(s), ' + when(i.receivedAt)}
                    </Text>
                  </View>
                  <View style={ui.row}>
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
