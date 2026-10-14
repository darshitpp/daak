import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import type { DaakEvent, DeviceInfo, TransferSummary } from '@daak/core';
import { useEngine } from '../EngineContext';
import { Bubble } from '../components/Bubble';
import { Sheet } from '../components/Sheet';
import { useToast } from '../components/Toast';
import { Btn, Empty, Note, ProgressBar, Status, deviceLabel, presenceOf, type DeviceNoun } from '../components/ds';
import type { InboxActions } from '../inbox-actions';
import { colors, control, ui } from '../theme';
import { humanBytes } from './quarantine-facts';
import { EMPTY_THREAD, itemKey, mergeThread, prependOlder, type ThreadView } from './thread-merge';

const PAGE = 50;
// More staged files than this fold into one summary chip. The composer must keep a fixed height.
const MAX_CHIPS = 3;
// How near the bottom (in points) still counts as "reading the newest items".
const NEAR_BOTTOM = 80;
// Events that can change this thread. transfer.item and transfer.done carry no
// peer id, so any of them refetches (spec 5.1 "Events").
const REFETCH_ON: ReadonlySet<DaakEvent['type']> = new Set<DaakEvent['type']>([
  'transfer.item',
  'transfer.done',
  'transfer.failed',
  'inbox.received',
  'outbox.queued',
  'device.state',
  'device.presence',
  'pairing.done',
  'pairing.revoked',
]);

const base = (p: string): string => p.split(/[\\/]/).pop() ?? p;
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const errText = (e: unknown, fallback: string): string => (e instanceof Error ? e.message : fallback);

/** The composer, inside a keyboard avoiding view only when the host asks. */
function ComposerWrap({ avoid, children }: { avoid: boolean; children: React.ReactNode }) {
  return avoid ? (
    <KeyboardAvoidingView testID="thread-keyboard-avoiding" behavior="padding">{children}</KeyboardAvoidingView>
  ) : (
    <>{children}</>
  );
}

// A failure that needs the user to act. A success is a toast, not a result.
type Result = { title: string; body: string; retry?: boolean } | null;

/**
 * The conversation with one paired device (design: `contact-detail`). It
 * replaces the Send, Inbox, and Transfers tabs.
 *
 * The device comes from `devices()`. `null` after the first load means the
 * engine does not list it: it was never paired, or it was removed. Then the
 * screen shows no history. `revoke_pairing` keeps the transfer rows, and a
 * queued row to a removed device never resolves.
 */
export function ThreadScreen({
  peerDeviceId,
  onBack,
  onPickFiles,
  actions,
  onOpenHeld,
  initialText = '',
  initialFiles = [],
  deviceNoun = 'phone',
  keyboardAvoiding = false,
}: {
  peerDeviceId: string;
  onBack: () => void;
  onPickFiles?: () => Promise<string[]>;
  actions?: InboxActions;
  onOpenHeld?: (r: { transferId: string; itemIndex: number }) => void;
  initialText?: string;
  initialFiles?: string[];
  deviceNoun?: DeviceNoun;
  keyboardAvoiding?: boolean;
}) {
  const engine = useEngine();
  const toast = useToast();
  const [device, setDevice] = useState<DeviceInfo | null | undefined>(undefined);
  const [thread, setThread] = useState<ThreadView>(EMPTY_THREAD);
  const [summaries, setSummaries] = useState<TransferSummary[]>([]);
  const [progress, setProgress] = useState<Record<string, { done: number; total: number }>>({});
  const [loadError, setLoadError] = useState('');
  const [paging, setPaging] = useState(false);
  const [text, setText] = useState(initialText);
  const [files, setFiles] = useState<string[]>(initialFiles);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<Result>(null);
  const [stopFor, setStopFor] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);

  const alive = useRef(true);
  const seq = useRef(0);
  const frame = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);
  const scroller = useRef<ScrollView>(null);
  const stick = useRef(true); // the user is near the bottom
  const metrics = useRef({ offset: 0, content: 0, view: 0 });
  const anchor = useRef<{ content: number; offset: number } | null>(null);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const [page, all, devs] = await Promise.all([
        engine.listThread(peerDeviceId, { limit: PAGE }),
        engine.listTransfers({ peerDeviceId, state: 'active' }),
        engine.devices(),
      ]);
      // A newer request started after this one. Its answer wins.
      if (!alive.current || mine !== seq.current) return;
      setThread((prev) => mergeThread(prev, page));
      setSummaries(all);
      // A device that the engine lists but has not paired is "not paired":
      // the engine refuses a send to it.
      const found = devs.find((d) => d.deviceId === peerDeviceId);
      setDevice(found !== undefined && found.paired === true ? found : null);
      setLoadError('');
    } catch (e) {
      if (alive.current && mine === seq.current) setLoadError(errText(e, 'the engine did not answer'));
    }
  }, [engine, peerDeviceId]);

  // One refetch for each animation frame, however many events arrive.
  const schedule = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      void load();
    });
  }, [load]);

  useEffect(() => {
    alive.current = true;
    void load();
    const off = engine.on((e) => {
      if (e.type === 'transfer.progress') {
        setProgress((p) => ({ ...p, [e.transferId]: { done: e.bytesDone, total: e.bytesTotal } }));
      } else if (REFETCH_ON.has(e.type)) {
        schedule();
      }
    });
    return () => {
      alive.current = false;
      off();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [engine, load, schedule]);

  const loadOlder = async () => {
    if (thread.olderCursor === null || paging) return;
    setPaging(true);
    // Read the place before the await. Set the anchor only when the page adds
    // items, so an empty or duplicate-only page leaves no stale anchor.
    const place = { content: metrics.current.content, offset: metrics.current.offset };
    try {
      const page = await engine.listThread(peerDeviceId, { limit: PAGE, before: thread.olderCursor });
      if (alive.current) {
        const next = prependOlder(thread, page);
        if (next.items.length > thread.items.length) anchor.current = place;
        setThread((prev) => prependOlder(prev, page));
      }
    } catch (e) {
      if (alive.current) setLoadError(errText(e, 'the engine did not answer'));
    } finally {
      if (alive.current) setPaging(false);
    }
  };

  const onScroll = (ev: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = ev.nativeEvent;
    metrics.current = { offset: contentOffset.y, content: contentSize.height, view: layoutMeasurement.height };
    stick.current = contentSize.height - (contentOffset.y + layoutMeasurement.height) <= NEAR_BOTTOM;
    if (contentOffset.y <= 40) void loadOlder();
  };

  // A new page above keeps the reader's place. A new item below follows the
  // newest only when the reader was already at the bottom, so a resize or a
  // rotation while the reader scrolls up does not move the list.
  const onContentSize = (_w: number, h: number) => {
    const a = anchor.current;
    if (a !== null) {
      anchor.current = null;
      scroller.current?.scrollTo({ y: a.offset + (h - a.content), animated: false });
    } else if (stick.current) {
      scroller.current?.scrollToEnd({ animated: false });
    }
    metrics.current.content = h;
  };

  const name = device ? deviceLabel(device) : 'this device';
  const canSend = device != null && (files.length > 0 || text.trim() !== '') && !sending;

  const pick = () => {
    if (!onPickFiles) return;
    // A picker that rejects leaves the composer usable. Both native pickers
    // resolve an empty list on Cancel.
    // The picker is modal, so `files` cannot change while it is open. The toast
    // says the total count, as the design does ("{n} file(s) ready").
    void onPickFiles()
      .then((picked) => {
        const next = [...files, ...picked.filter((p) => !files.includes(p))];
        if (next.length === files.length) return;
        setFiles(next);
        toast.show(`${plural(next.length, 'file', 'files')} ready`);
      })
      .catch(() => {});
  };

  const submit = async () => {
    if (device == null || !canSend) return;
    setSending(true);
    setResult(null);
    const note = text.trim();
    // The engine reports queued: true for every send. The words come from the
    // presence of the peer at the time of the send.
    const waiting = presenceOf(device).rank >= 2;
    try {
      // Files first, then the note. send() takes one kind in each call. Each
      // part leaves the composer as soon as the engine accepts it, so a failed
      // note does not send the files again.
      if (files.length > 0) {
        await engine.send({ peerDeviceId, files });
        setFiles([]);
      }
      if (note !== '') {
        await engine.send({ peerDeviceId, text: note });
        setText('');
      }
      toast.show(waiting ? `Will send when ${name} is back` : `Sent to ${name}`);
      stick.current = true;
    } catch (e) {
      setResult({
        title: 'That send did not go through',
        body: errText(e, 'The engine refused the send.'),
        retry: true,
      });
    } finally {
      if (alive.current) setSending(false);
      schedule();
    }
  };

  const stop = async () => {
    const id = stopFor;
    setStopFor(null);
    if (id === null) return;
    try {
      await engine.cancel(id);
      toast.show('Sending stopped');
    } catch (e) {
      setResult({ title: 'Sending did not stop', body: errText(e, 'The engine refused.') });
    }
    schedule();
  };

  // A queued bubble has sent nothing yet. Stop cancels at once (design).
  const stopWaiting = async (transferId: string) => {
    try {
      await engine.cancel(transferId);
      toast.show('Stopped');
    } catch (e) {
      setResult({ title: 'Sending did not stop', body: errText(e, 'The engine refused.') });
    }
    schedule();
  };

  const retry = async (transferId: string) => {
    try {
      await engine.retry(transferId);
      // The task order: the app shows the design success word after a Retry.
      toast.show(`Sent to ${name}`);
    } catch (e) {
      setResult({ title: 'Try again did not work', body: errText(e, 'The engine refused.') });
    }
    schedule();
  };

  const header = (
    <View style={ui.appbar}>
      <Pressable
        testID="thread-back"
        accessibilityRole="button"
        accessibilityLabel="Go back"
        accessibilityHint="Back to the device list"
        onPress={onBack}
        style={ui.iconbtn}
      >
        <Text style={ui.appbarGlyph}>‹</Text>
      </Pressable>
      <View style={ui.fill}>
        <Text style={ui.h3} numberOfLines={1} accessibilityRole="header">{device ? name : 'Conversation'}</Text>
        {device ? <Status tone={presenceOf(device).tone} label={presenceOf(device).label} /> : null}
      </View>
    </View>
  );

  if (device === undefined && loadError === '') {
    return <View style={ui.screen}>{header}</View>;
  }

  if (device === null) {
    return (
      <View style={ui.screen}>
        {header}
        <View style={ui.pad}>
          <View testID="thread-not-paired">
            <Empty
              title="Not paired any more"
              body="This device is not in your list. Pair it again to send to it."
              action={<Btn label="Back to devices" onPress={onBack} testID="thread-not-paired-back" />}
            />
          </View>
        </View>
      </View>
    );
  }

  const removeChip = (p: string) => (
    <Pressable
      key={p}
      onPress={() => setFiles((f) => f.filter((x) => x !== p))}
      accessibilityRole="button"
      accessibilityLabel={`Remove ${base(p)}`}
      testID={`remove-${base(p)}`}
      style={({ pressed }) => [ui.chip, pressed ? ui.pressed : null]}
    >
      <Text style={ui.chipLabel} numberOfLines={1}>{base(p)}</Text>
      <Text style={ui.chipLabelOn}>×</Text>
    </Pressable>
  );

  const active = summaries.filter((s) => s.direction === 'out' && s.state === 'active');
  const offline = device != null && device.presence === 'offline';

  return (
    <View style={ui.screen}>
      {header}
      <ScrollView
        ref={scroller}
        contentContainerStyle={ui.threadList}
        onScroll={onScroll}
        scrollEventThrottle={64}
        onContentSizeChange={onContentSize}
        keyboardShouldPersistTaps="handled"
      >
        {loadError !== '' ? (
          <View style={ui.stackSm}>
            <Note tone="err" title="The conversation did not load" body={loadError} testID="thread-error" />
            <Btn label="Try again" variant="quiet" onPress={() => void load()} testID="thread-reload" />
          </View>
        ) : null}
        {thread.olderCursor !== null ? (
          <Btn label="Show earlier" variant="ghost" disabled={paging} onPress={() => void loadOlder()} testID="thread-load-older" />
        ) : null}
        {device !== undefined && thread.items.length === 0 && loadError === '' ? (
          <Empty title="Nothing here yet" body="Send the first file or note with the buttons below. It travels straight to this device over your Wi-Fi." />
        ) : null}
        {thread.items.map((it, idx) => (
          <React.Fragment key={itemKey(it)}>
          <Bubble
            item={it}
            onCopy={
              actions?.copy
                ? (t) => {
                    actions.copy?.(t);
                    toast.show('Copied');
                  }
                : undefined
            }
            onCopyWhole={
              actions?.copy
                ? (i) => {
                    // The page cut this text. Copy the whole text, or copy nothing.
                    void engine.getItemText(i.transferId, i.itemIndex).then(
                      (whole) => {
                        actions.copy?.(whole);
                        toast.show('Copied');
                      },
                      () => toast.show('Could not copy the whole text.'),
                    );
                  }
                : undefined
            }
            onPreview={
              actions?.open
                ? (i) => {
                    const open = actions.open;
                    // Ruling: a Preview that no app can open is a toast.
                    const noApp = () => toast.show('This device cannot open files.');
                    if (open && i.destPath !== null) {
                      void open(i.destPath).then((ok) => { if (!ok) noApp(); }, noApp);
                    }
                  }
                : undefined
            }
            onShare={actions?.share ? (i) => i.destPath !== null && actions.share?.([i.destPath]) : undefined}
            onOpenHeld={onOpenHeld ? (i) => onOpenHeld({ transferId: i.transferId, itemIndex: i.itemIndex }) : undefined}
            onRetry={(i) => void retry(i.transferId)}
            onStop={(i) => void stopWaiting(i.transferId)}
          />
          {/* The engine cut the item list of this send. Say so once, after its last kept item. */}
          {it.truncated === true && thread.items[idx + 1]?.transferId !== it.transferId ? (
            <Text style={ui.hint}>Some items of this send are not shown.</Text>
          ) : null}
          </React.Fragment>
        ))}
      </ScrollView>

      {active.map((s) => {
        const live = progress[s.transferId];
        const done = live?.done ?? s.bytesDone;
        const total = live?.total ?? s.bytesTotal;
        const known = done > 0 && total > 0;
        const pct = known ? Math.floor((done / total) * 100) : 0;
        return (
          <View key={s.transferId} style={[ui.card, { marginHorizontal: 12, marginBottom: 8 }]} testID={`thread-active-${s.transferId}`}>
            <Text style={ui.h3}>{`Sending to ${name}`}</Text>
            <Text style={ui.hint}>
              {[plural(s.itemCount, 'item', 'items'), humanBytes(total)].filter(Boolean).join(' · ')}
            </Text>
            <ProgressBar pct={pct} />
            <View style={ui.progMeta}>
              <Text style={ui.hint}>Sending over your Wi-Fi</Text>
              {known ? <Text style={ui.progN}>{pct + '%'}</Text> : null}
            </View>
            <Btn
              label="Stop sending"
              variant="danger"
              block
              testID={`thread-stop-${s.transferId}`}
              onPress={() => setStopFor(s.transferId)}
            />
          </View>
        );
      })}

      {result ? (
        <View style={{ paddingHorizontal: 12, gap: 8 }}>
          <Note tone="err" title={result.title} body={result.body} testID="thread-result" />
          {result.retry ? <Btn label="Try again" variant="quiet" onPress={() => void submit()} testID="thread-retry-send" /> : null}
        </View>
      ) : null}
      {offline && result === null ? (
        <View style={{ paddingHorizontal: 12 }}>
          {/* Design #cd-offline-note. The peer is Offline, not Away. */}
          <Note
            icon={<WifiOffIcon />}
            body={`${name} is not on this Wi-Fi. What you send waits here and goes when they are back.`}
          />
        </View>
      ) : null}

      <ComposerWrap avoid={keyboardAvoiding}>
      <View style={ui.composer}>
        {files.length > 0 ? (
          <View style={ui.stackSm}>
            <View style={[ui.row, { flexWrap: 'wrap' }]}>
              {files.length > MAX_CHIPS ? (
                <Pressable
                  onPress={() => setReviewing(true)}
                  accessibilityRole="button"
                  accessibilityLabel={`Review ${plural(files.length, 'file', 'files')}`}
                  testID="files-review"
                  style={({ pressed }) => [ui.chip, pressed ? ui.pressed : null]}
                >
                  <Text style={ui.chipLabel}>{`${plural(files.length, 'file', 'files')} · Review`}</Text>
                </Pressable>
              ) : (
                files.map((p) => removeChip(p))
              )}
            </View>
          </View>
        ) : null}
        <View style={ui.composerRow}>
          {onPickFiles ? <Btn label="Add files" variant="quiet" onPress={pick} testID="pick-files" /> : null}
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Or type a note"
            placeholderTextColor={colors.meta}
            accessibilityLabel="Type a note"
            multiline
            style={[ui.input, ui.fill, { maxHeight: 120, minHeight: control.minHeight, textAlignVertical: 'top' }]}
          />
          <Btn label="Send" variant="primary" disabled={!canSend} onPress={() => void submit()} testID="send" />
        </View>
      </View>
      </ComposerWrap>

      <Sheet
        open={reviewing && files.length > 0}
        title={plural(files.length, 'file', 'files')}
        onClose={() => setReviewing(false)}
        actions={<Btn label="Done" variant="quiet" block onPress={() => setReviewing(false)} testID="files-review-done" />}
      >
        <ScrollView style={{ maxHeight: 320 }} keyboardShouldPersistTaps="handled">
          <View style={ui.list}>
            {files.map((p) => (
              <View key={p} style={ui.listRow}>
                <Text style={[ui.rowTitle, ui.fill]} numberOfLines={1} ellipsizeMode="middle">{base(p)}</Text>
                <Btn
                  label="Remove"
                  accessibilityLabel={`Remove ${base(p)}`}
                  size="sm"
                  variant="quiet"
                  testID={`review-remove-${base(p)}`}
                  onPress={() => setFiles((f) => f.filter((x) => x !== p))}
                />
              </View>
            ))}
          </View>
        </ScrollView>
      </Sheet>

      <Sheet
        open={stopFor !== null}
        title="Stop sending?"
        onClose={() => setStopFor(null)}
        actions={
          <>
            <Btn label="Stop sending" variant="danger" block onPress={() => void stop()} testID="confirm-stop" />
            <Btn label="Keep sending" variant="ghost" block onPress={() => setStopFor(null)} testID="keep-sending" />
          </>
        }
      >
        <Text style={ui.lead}>
          {`Nothing has reached ${name} yet. If you stop now, the items stay on this ${deviceNoun}.`}
        </Text>
      </Sheet>
    </View>
  );
}

// The design `#cd-offline-note` icon: a wifi-off mark. react-native-svg is not
// a dependency, so three arcs, a dot, and a slash are View elements at the
// design geometry (viewBox 24). A number below is a design unit times K.
const WIFI_ICON = 20;
const WIFI_K = WIFI_ICON / 24;
const WIFI_STROKE = 1.75 * WIFI_K;
const WIFI_OX = 12 * WIFI_K; // The arcs spray from this point.
const WIFI_OY = 20 * WIFI_K;
const WIFI_RADII = [15, 10, 5]; // The three arc radii of the design.
const WIFI_SLASH = 20 * Math.SQRT2 * WIFI_K; // The slash runs 2,2 to 22,22.

/** One wifi arc. A quarter ring, turned to sit symmetric about the vertical. */
function WifiArc({ r, color }: { r: number; color: string }) {
  const d = r * WIFI_K;
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: WIFI_OX,
        top: WIFI_OY - d,
        width: d,
        height: d,
        borderTopWidth: WIFI_STROKE,
        borderRightWidth: WIFI_STROKE,
        borderTopColor: color,
        borderRightColor: color,
        borderTopRightRadius: d,
        transformOrigin: 'bottom left',
        transform: [{ rotate: '-45deg' }],
      }}
    />
  );
}

/**
 * The offline note icon of the design: a wifi mark with a slash. The stroke
 * uses the muted tone. The icon replaces the note dot.
 */
function WifiOffIcon({ color = colors.muted }: { color?: string }) {
  return (
    <View style={{ width: WIFI_ICON, height: WIFI_ICON }} testID="wifi-off-icon">
      {WIFI_RADII.map((r) => (
        <WifiArc key={r} r={r} color={color} />
      ))}
      <View
        style={{
          position: 'absolute',
          left: WIFI_OX - WIFI_STROKE / 2,
          top: WIFI_OY - WIFI_STROKE / 2,
          width: WIFI_STROKE,
          height: WIFI_STROKE,
          borderRadius: WIFI_STROKE / 2,
          backgroundColor: color,
        }}
      />
      <View
        style={{
          position: 'absolute',
          left: 12 * WIFI_K - WIFI_SLASH / 2,
          top: 12 * WIFI_K - WIFI_STROKE / 2,
          width: WIFI_SLASH,
          height: WIFI_STROKE,
          borderRadius: WIFI_STROKE / 2,
          backgroundColor: color,
          transform: [{ rotate: '45deg' }],
        }}
      />
    </View>
  );
}

