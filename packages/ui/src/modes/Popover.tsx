import React, { useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { DaakEngine, DeviceInfo, QuarantineReport } from '@daak/core';
import type { UiState } from '../state/store';
import { useConnection } from '../state/useConnection';
import { CANT_REACH_TOKEN } from '../state/useBlockers';
import {
  Avatar,
  Btn,
  Empty,
  Note,
  ProgressBar,
  Status,
  Wordmark,
  deviceLabel,
  presenceOf,
  type DeviceNoun,
} from '../components/ds';
import { NOT_RECORDED, fingerprintGroups, humanBytes } from '../screens/quarantine-facts';
import { RELEASES_URL } from '../screens/about-links';
import { colors, radius, spacing, ui } from '../theme';
import { isSelectable, panelDevices, percent, sendLine, sendViewOf, tail } from './panel-model';
import { useHeldBack } from './useHeldBack';
import { usePanelTransfer } from './usePanelTransfer';

/**
 * The menu-bar panel (design `macos-menubar.html`), 320 px wide.
 *
 * Panes: the device list, the send pane for one device, the sending pane, the
 * done pane, and the failed pane. A queued send to an offline device does not
 * take a pane. It shows as a note above the panes, so the user can still pick
 * another device. The held-back card and the "Open the full app" button show on
 * every pane. An update notice is a BANNER above the panes, so the panes stay
 * usable. Only the cannot-reach screen replaces the panes.
 *
 * `onExpand` opens the dashboard WINDOW. That is the host shell's job. The
 * engine has no such verb, so this must never call `engine.start()`.
 *
 * "Sent" has the engine meaning: `engine.send` resolves when the outbox has
 * accepted the batch. The sending pane then follows the real transfer. The
 * panel does not cancel a transfer when it closes (see `usePanelTransfer`).
 *
 * The panel sends one file at a time, as the design does. The thread sends several files at once.
 */
export function Popover({
  state,
  engine,
  onExpand,
  onPickFiles,
  alert,
  alertRouteToken,
  deviceNoun = 'device',
}: {
  state: UiState;
  engine: DaakEngine;
  onExpand: () => void;
  /** The native file panel. Without one, the send pane has no picker button. */
  onPickFiles?: () => Promise<string[]>;
  /*
   * See DaakUiApp. The popover is a window that the user opens from the menu
   * bar. An `alert` with no token is the resting state of a healthy launch and
   * must render nothing, so AppShell and this panel treat the pair as one
   * decision.
   */
  alert?: React.ReactNode;
  alertRouteToken?: string;
  /** The word for this device in the held-back text. The host sets it. */
  deviceNoun?: DeviceNoun | 'device';
}) {
  // The token says which notice it is (see `useBlockers`). Only Cannot reach
  // replaces the panes. Update available is a banner above them.
  const unreachable = alert !== undefined && alertRouteToken === CANT_REACH_TOKEN;
  const update = alert !== undefined && alertRouteToken !== undefined && !unreachable;
  const connection = useConnection(engine);
  const transfer = usePanelTransfer(engine);
  const held = useHeldBack(engine);
  const [target, setTarget] = useState<DeviceInfo | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ tone: 'ok' | 'err'; title: string; body: string } | null>(null);

  const devices = panelDevices(state.devices);
  // One note for every pane. `stop` and `retry` set `result` while a transfer
  // pane shows, so the running, done, and failed panes must render it too.
  const resultNote = result ? (
    <Note tone={result.tone} title={result.title} body={result.body} testID="popover-result" />
  ) : null;
  const peerOf = (id: string) => state.devices.find((d) => d.deviceId === id);
  const nameOf = (id: string) => deviceLabel(peerOf(id) ?? { name: '', deviceId: id });

  const choose = (d: DeviceInfo) => {
    setTarget(d);
    setResult(null);
  };
  const back = () => {
    setTarget(null);
    setFiles([]);
    setChosen(null);
    setNote('');
    setResult(null);
  };
  // A cancelled native picker resolves EMPTY. A rejection means the panel broke.
  // Both leave the pane usable.
  const pick = () => {
    if (!onPickFiles) return;
    void onPickFiles()
      .then((picked) => {
        if (picked.length === 0) return;
        setFiles((f) => [...f, ...picked.filter((p) => !f.includes(p))]);
        setChosen(picked[0]);
      })
      .catch(() => setResult({ tone: 'err', title: 'The file panel did not open', body: 'Try again in a moment.' }));
  };
  const submit = async () => {
    const text = note.trim();
    if (target === null || sending || (chosen === null && text === '')) return;
    setSending(true);
    setResult(null);
    try {
      if (chosen !== null) {
        const r = await engine.send({ peerDeviceId: target.deviceId, files: [chosen] });
        transfer.begin({ transferId: r.transferId, peerDeviceId: target.deviceId, label: tail(chosen) });
        setFiles([]);
        setChosen(null);
        if (text !== '') {
          // The file leaves first, then the note, as 2 transfers (the engine
          // accepts text or files in one request, not both).
          try {
            await engine.send({ peerDeviceId: target.deviceId, text });
            setNote('');
          } catch (e) {
            setResult({
              tone: 'err',
              title: 'The note did not go through',
              body: e instanceof Error ? e.message : 'The engine refused the note.',
            });
          }
        }
      } else {
        const r = await engine.send({ peerDeviceId: target.deviceId, text });
        transfer.begin({ transferId: r.transferId, peerDeviceId: target.deviceId, label: text });
        setNote('');
      }
    } catch (e) {
      setResult({
        tone: 'err',
        title: 'That send did not go through',
        body: e instanceof Error ? e.message : 'The engine refused the send.',
      });
    } finally {
      setSending(false);
    }
  };
  // "Back to sending" leaves the transfer. A note about it must go too.
  const leaveTransfer = () => {
    transfer.clear();
    setResult(null);
  };
  const stop = () => {
    setResult(null);
    void transfer.stop().then((message) => {
      if (message !== null) setResult({ tone: 'err', title: 'Sending did not stop', body: message });
    });
  };
  const retry = () => {
    setResult(null);
    void transfer.retry().then((message) => {
      if (message !== null) setResult({ tone: 'err', title: 'That send did not start again', body: message });
    });
  };

  // What the transfer pane shows. A transfer with no row yet is a running one
  // that the engine has not listed.
  const view =
    transfer.send === null
      ? null
      : transfer.row === null
        ? ({ kind: 'running', waiting: false, done: 0, total: 0 } as const)
        : sendViewOf(transfer.row, peerOf(transfer.send.peerDeviceId));

  const conn =
    connection.wifi === 'connected'
      ? { tone: 'ok' as const, label: 'On this network' }
      : connection.wifi === 'not-connected'
        ? { tone: 'off' as const, label: 'No device found on this Wi-Fi' }
        : { tone: 'off' as const, label: 'Looking for devices' };

  // A queued send to an offline or unknown device does not take over the panel.
  // The user must still be able to pick another device, so the waiting transfer
  // shows as a note above the panes, with its own stop control.
  const waiting = view !== null && view.kind === 'running' && view.waiting;
  const waitingNote =
    transfer.send !== null && view !== null && view.kind === 'running' && view.waiting ? (
      <View style={ui.stackSm} testID="popover-waiting">
        <Note
          tone="warn"
          title={`Will send when ${nameOf(transfer.send.peerDeviceId)} is back`}
          body={sendLine(transfer.send.label, view.total) || 'It stays queued until then.'}
        />
        <Btn variant="ghost" block testID="popover-stop" label="Stop sending" onPress={stop} />
        {/* A failed stop sets `result`. The pane below renders it, so this view does not. */}
      </View>
    ) : null;

  let pane: React.ReactNode;
  if (transfer.send !== null && view !== null && view.kind !== 'stopped' && !waiting) {
    const who = nameOf(transfer.send.peerDeviceId);
    const label = transfer.send.label;
    if (view.kind === 'running') {
      const pct = percent(view.done, view.total);
      pane = (
        <View style={ui.stackSm} testID="popover-sending">
          <Text style={ui.h3}>{`Sending to ${who}`}</Text>
          {sendLine(label, view.total) === '' ? null : (
            <Text style={ui.hint} numberOfLines={1}>{sendLine(label, view.total)}</Text>
          )}
          <ProgressBar pct={pct ?? 0} />
          <View style={ui.progMeta}>
            <Text style={ui.hint}>Sending over your Wi-Fi</Text>
            {pct === null ? null : <Text style={ui.progN}>{pct + '%'}</Text>}
          </View>
          <Btn variant="ghost" block testID="popover-stop" label="Stop sending" onPress={stop} />
          {resultNote}
        </View>
      );
    } else if (view.kind === 'done') {
      pane = (
        <View style={ui.stackSm} testID="popover-done">
          <Text style={ui.h3}>{`Sent to ${who}`}</Text>
          {sendLine(label, view.total) === '' ? null : (
            <Text style={ui.hint} numberOfLines={1}>{sendLine(label, view.total)}</Text>
          )}
          <Btn variant="ghost" block testID="popover-done-back" label="Back to sending" onPress={leaveTransfer} />
          {resultNote}
        </View>
      );
    } else {
      pane = (
        <View style={ui.stackSm} testID="popover-failed">
          <Note
            tone="err"
            title="That send did not go through"
            body={transfer.failure ?? 'The transfer failed.'}
          />
          <Btn variant="quiet" block testID="popover-retry" label="Try again" onPress={retry} />
          <Btn variant="ghost" block testID="popover-done-back" label="Back to sending" onPress={leaveTransfer} />
          {resultNote}
        </View>
      );
    }
  } else if (target !== null) {
    pane = (
      <View style={ui.stackSm}>
        <Btn label="Devices" variant="ghost" block testID="popover-back" onPress={back} />
        <Text style={ui.h3}>{deviceLabel(target)}</Text>
        {onPickFiles ? (
          <Btn label="Add files" variant="quiet" block testID="popover-pick" onPress={pick} />
        ) : null}
        {files.length > 0 ? (
          <View accessibilityRole="radiogroup" accessibilityLabel="Add files" style={ui.list}>
            {files.map((p) => (
              <Pressable
                key={p}
                accessibilityRole="radio"
                accessibilityLabel={'popover-file-' + tail(p)}
                accessibilityState={{ checked: chosen === p }}
                onPress={() => setChosen(p)}
                style={({ pressed }) => [ui.listRow, pressed ? ui.pressed : null]}
              >
                <Text style={[ui.rowTitle, ui.fill]} numberOfLines={1}>{tail(p)}</Text>
                {chosen === p ? <Text style={ui.rowTitle}>{'✓'}</Text> : null}
              </Pressable>
            ))}
          </View>
        ) : null}
        <TextInput
          value={note}
          onChangeText={setNote}
          placeholder="Or type a note"
          placeholderTextColor={colors.meta}
          accessibilityLabel="Type a note"
          testID="popover-note"
          autoCorrect={false}
          style={ui.input}
        />
        <Btn
          variant="primary"
          block
          testID="popover-send"
          disabled={sending || (chosen === null && note.trim() === '')}
          onPress={() => void submit()}
          label={chosen !== null ? `Send to ${deviceLabel(target)}` : 'Send'}
        />
        {resultNote}
      </View>
    );
  } else {
    pane = (
      <View style={ui.stackSm}>
        <Text style={ui.sectionT}>Devices</Text>
        {devices.map((d) => (
          <DeviceRow key={d.deviceId} d={d} onChoose={choose} />
        ))}
        {devices.length === 0 ? (
          <Empty title="No paired devices yet" body="Pair a device on your Wi-Fi and it will show up here." />
        ) : null}
        {resultNote}
      </View>
    );
  }

  return (
    <View style={{ width: 320, flex: 1, backgroundColor: colors.bg }} testID="popover-root">
      <View style={{ padding: spacing.lg, paddingBottom: spacing.sm, gap: spacing.sm }}>
        <Wordmark size="sm" />
        {unreachable ? null : <Status tone={conn.tone} label={conn.label} />}
      </View>
      {unreachable ? (
        // REPLACES the panes. The screen says Daak cannot reach a device, and a
        // Send control beside that claim would contradict it.
        <View style={{ padding: spacing.lg }}>{alert}</View>
      ) : (
        <>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}
            keyboardShouldPersistTaps="handled"
          >
            {update ? <UpdateBanner /> : null}
            {waitingNote}
            {pane}
            {held ? <HeldCard report={held} deviceNoun={deviceNoun} /> : null}
          </ScrollView>
          <View style={{ padding: spacing.lg }}>
            <Btn variant="ghost" block testID="open-dashboard" label="Open the full app" onPress={onExpand} />
          </View>
        </>
      )}
    </View>
  );
}

/**
 * The update notice of the design (`macos-menubar.html`, `#update-banner`).
 *
 * It is a BANNER and not a view, so the device list, Send, and "Open the full
 * app" stay reachable while it is showing. The button opens the releases page
 * through the platform, as the Settings links do (ruling D2: no updater).
 */
function UpdateBanner() {
  return (
    <View style={styles.banner} testID="popover-update-banner">
      <Text style={ui.noteTxt}>
        A newer version of Daak is out. Some devices may not connect until you update.
      </Text>
      <Btn
        variant="quiet"
        block
        testID="popover-update-download"
        label="Open the download page"
        onPress={() => void Linking.openURL(RELEASES_URL).catch(() => {})}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // The design `.pop-banner`: a warn-tinted block, 8 by 12 padding.
  banner: {
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.warnTint,
    borderRadius: radius.sm,
    backgroundColor: colors.warnTint,
  },
});

/**
 * A device row. An offline device shows and cannot be chosen (design:
 * `aria-disabled`). An away device can be chosen, because it holds the item.
 */
function DeviceRow({ d, onChoose }: { d: DeviceInfo; onChoose: (d: DeviceInfo) => void }) {
  const view = presenceOf(d);
  const selectable = isSelectable(d);
  const label = deviceLabel(d);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={'send-to-' + d.deviceId}
      disabled={!selectable}
      onPress={() => onChoose(d)}
      style={({ pressed }) => [ui.listRow, selectable ? null : { opacity: 0.55 }, pressed ? ui.pressed : null]}
    >
      <Avatar letter={label} />
      <View style={ui.fill}>
        <Text style={ui.rowTitle} numberOfLines={1}>{label}</Text>
        <Status tone={view.tone} label={view.label} />
      </View>
    </Pressable>
  );
}

/** The newest held-back item. Its facts are the ones the engine recorded. */
function HeldCard({ report, deviceNoun }: { report: QuarantineReport; deviceNoun: string }) {
  const [open, setOpen] = useState(false);
  const name = report.name ?? NOT_RECORDED;
  const line = report.size === null ? name : `${name} · ${humanBytes(report.size)}`;
  return (
    <View style={ui.stackSm} testID="popover-held">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="popover-held-toggle"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((v) => !v)}
        style={({ pressed }) => [ui.cardTight, { flexDirection: 'row', alignItems: 'flex-start' }, pressed ? ui.pressed : null]}
      >
        <View style={[ui.dot, { backgroundColor: colors.warn, marginTop: 6 }]} />
        <View style={ui.fill}>
          <Text style={ui.rowTitle}>Held back</Text>
          <Text style={ui.rowSub} numberOfLines={1}>{line}</Text>
        </View>
        <Text style={ui.hint}>What does this mean?</Text>
      </Pressable>
      {open ? (
        <View style={ui.cardTight} testID="popover-held-why">
          <Text style={ui.hint}>
            {`Its check did not match what the sender promised, so it was not opened. Nothing was deleted and nothing left this ${deviceNoun}.`}
          </Text>
          <View style={[ui.kv, ui.kvFirst]}>
            <Text style={ui.kvK}>Fingerprint it should have</Text>
            <Text style={[ui.kvV, ui.nowrap, ui.mono]}>{fingerprintGroups(report.expected)}</Text>
          </View>
          <View style={[ui.kv, ui.kvFirst]}>
            <Text style={ui.kvK}>Fingerprint it has</Text>
            <Text style={[ui.kvV, ui.nowrap, ui.mono]}>{fingerprintGroups(report.actual)}</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}
