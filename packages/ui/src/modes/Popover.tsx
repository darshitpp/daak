import React, { useState } from 'react';
import { Text, View } from 'react-native';
import type { DeviceInfo } from '@daak/core';
import type { TransferRow, UiState } from '../state/store';
import { DeviceCard } from '../components/DeviceCard';
import { ProgressRow } from '../components/ProgressRow';
import { Btn, Note, Status, Wordmark } from '../components/ds';
import { control, colors, ui } from '../theme';

/** The last segment of a path: what a person recognises a file by. */
const tail = (p: string): string => p.split('/').pop() || p;

/**
 * Menu-bar popover, the prototype's 320px panel: wordmark + connection state,
 * the nearby devices, whatever is moving, and one way out to the real window.
 *
 * The panel's two steps are the prototype's: pick a device, then pick a file
 * and send. `onExpand` opens the dashboard WINDOW, which is the host shell's
 * business -- the engine has no such verb, so this must never be wired to
 * engine.start().
 *
 * "Sent" here means what the engine means by it: engine.send resolves when the
 * outbox has durably accepted the batch (queued != delivered), so the note says
 * queued and the live transfer keeps moving in the row below.
 *
 * `onPickFiles` is the NSOpenPanel-backed picker, injected by the desktop shell
 * exactly as the dashboard gets it. Without one the file step is not rendered:
 * a picker button that opens nothing is a dead control.
 */
export function Popover({ state, engine, onExpand, onPickFiles }: {
  state: UiState;
  engine: {
    send(req: { peerDeviceId: string; files?: string[] }): Promise<{ transferId: string; queued: boolean }>;
  };
  onExpand: () => void;
  onPickFiles?: () => Promise<string[]>;
}) {
  const devices = state.devices.slice(0, 3);
  const transfer = state.transfers.find((t: TransferRow) => t.state === 'active');
  const [target, setTarget] = useState<DeviceInfo | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ tone: 'ok' | 'err'; title: string; body: string } | null>(null);

  const choose = (d: DeviceInfo) => {
    setTarget(d);
    setResult(null);
  };
  const back = () => {
    setTarget(null);
    setFiles([]);
    setResult(null);
  };
  // A cancelled native picker resolves EMPTY; a rejection means the panel
  // broke. Both leave the step usable rather than killing the popover.
  const pick = () => {
    if (!onPickFiles) return;
    void onPickFiles()
      .then((picked) => setFiles((f) => [...f, ...picked]))
      .catch(() => setResult({ tone: 'err', title: 'The file panel did not open', body: 'Try again in a moment.' }));
  };
  const send = () => {
    if (target === null || files.length === 0 || sending) return;
    setSending(true);
    setResult(null);
    void engine
      .send({ peerDeviceId: target.deviceId, files })
      .then(
        () => {
          setResult({
            tone: 'ok',
            title: `Queued for ${target.name}`,
            body: `${files.map(tail).join(', ')} goes over your own Wi-Fi. Watch it below.`,
          });
          setFiles([]);
        },
        (e: unknown) =>
          setResult({
            tone: 'err',
            title: 'That send did not go through',
            body: e instanceof Error ? e.message : 'The engine refused the send.',
          }),
      )
      .finally(() => setSending(false));
  };

  return (
    <View style={{ width: 320, padding: 16, gap: 12, backgroundColor: colors.bg }}>
      <View style={ui.row}>
        <Wordmark size="sm" />
        <View style={ui.fill}>
          <Status tone={transfer ? 'warn' : 'ok'} label={transfer ? 'Sending right now' : 'Ready to send'} />
        </View>
      </View>

      {target === null ? (
        <View style={ui.stackSm}>
          <Text style={ui.sectionT}>Send to</Text>
          {devices.map((d) => (
            <DeviceCard key={d.deviceId} device={d} onSend={choose} />
          ))}
          {devices.length === 0 ? (
            <Text style={ui.muted}>No devices nearby. Both devices need the same Wi-Fi.</Text>
          ) : null}
        </View>
      ) : (
        <View style={ui.stackSm}>
          <Btn label="All devices" variant="ghost" block testID="popover-back" onPress={back} />
          <Text style={ui.sectionT}>What should go to {target.name}?</Text>
          {files.map((p) => (
            <View key={p} style={[ui.row, { minHeight: control.minHeight }]}>
              <Text style={[ui.rowTitle, ui.fill]} numberOfLines={1}>{tail(p)}</Text>
              <Btn
                label="Remove"
                variant="ghost"
                testID={'popover-remove-' + tail(p)}
                onPress={() => setFiles((f) => f.filter((x) => x !== p))}
              />
            </View>
          ))}
          {onPickFiles ? (
            <Btn
              label={files.length === 0 ? 'Choose a file' : 'Add another'}
              variant="quiet"
              block
              testID="popover-pick"
              onPress={pick}
            />
          ) : null}
          {files.length > 0 ? (
            <Btn
              variant="primary"
              block
              testID="popover-send"
              disabled={sending}
              onPress={send}
              label={sending ? 'Queueing' : 'Send'}
            />
          ) : null}
          {result ? <Note tone={result.tone} title={result.title} body={result.body} testID="popover-result" /> : null}
        </View>
      )}

      {transfer ? (
        <ProgressRow name={transfer.transferId} bytesDone={transfer.bytesDone}
          bytesTotal={transfer.bytesTotal} state={transfer.state} />
      ) : null}

      <Btn variant="ghost" block testID="open-dashboard" label="Open the full app" onPress={onExpand} />
    </View>
  );
}
