import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { DeviceInfo } from '@daak/core';
import { useEngine } from '../EngineContext';
import { AttachmentPicker } from '../components/AttachmentPicker';
import { Btn, Empty, Note, Status, devicePresence } from '../components/ds';
import { ui } from '../theme';

/**
 * The Send tab: the prototype's send screen, wired to the engine.
 *
 * `peer` is a ROUTE value -- DeviceCard's Send button sets it and this screen
 * is the one surface it lands on. `initialPeerDeviceId` is the daak://send
 * deep-link target and WINS over `peer`; naming an unknown device yields no
 * target at all, because falling back to devices[0] would send the file to a
 * machine the link never named. `initialText` prefills the note box.
 */
export function SendScreen({ peer, initialPeerDeviceId, initialText, initialFiles, onPickFiles, onPeerChange }: {
  peer?: DeviceInfo | null;
  initialPeerDeviceId?: string;
  initialText?: string;
  initialFiles?: string[];
  onPickFiles?: () => Promise<string[]>;
  onPeerChange?: (d: DeviceInfo | null) => void;
}) {
  const engine = useEngine();
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [override, setOverride] = useState<string | undefined>();
  const [files, setFiles] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [readError, setReadError] = useState('');
  const [result, setResult] = useState<{ tone: 'ok' | 'err'; title: string; body: string } | null>(null);

  // A deep link names its peer EXPLICITLY, so it beats a chip the user tapped
  // earlier in the session -- otherwise `daak://send?deviceId=A` opens a
  // composer still pointing at B, and the file goes to B. The link is the more
  // recent instruction, so it clears the local choice and wins.
  useEffect(() => {
    if (initialPeerDeviceId !== undefined) setOverride(undefined);
  }, [initialPeerDeviceId]);

  // Same argument for the text: the link's note REPLACES whatever the user
  // already typed -- including replacing it with nothing, because a link with
  // no text carries no note to the new target and carrying the old one would
  // send it to a peer the user never tapped. `!== undefined` (not truthy) so an
  // ordinary mount, which passes no initialText at all, still does not wipe
  // what is being typed. Keyed on the value, so an unrelated re-render cannot
  // wipe what is being typed either.
  useEffect(() => {
    if (initialText !== undefined) setText(initialText);
  }, [initialText]);

  // Same for the share-sheet's files: a staged share REPLACES the attachment
  // list, because those bytes are already gone from the native inbox and this
  // is the only place they exist.
  useEffect(() => {
    if (initialFiles !== undefined) setFiles(initialFiles);
  }, [initialFiles]);

  useEffect(() => {
    const refresh = () =>
      void engine.devices().then(setDevices, (e: unknown) =>
        // A rejected devices() with no message on screen reads as "no devices
        // nearby", which sends the user to check the Wi-Fi instead of the log.
        setReadError(e instanceof Error ? e.message : 'the engine did not answer with a device list'),
      );
    refresh();
    return engine.on((e) => {
      if (e.type === 'device.state' || e.type === 'device.discovered') refresh();
    });
  }, [engine]);

  const target =
    override !== undefined
      ? devices.find((d) => d.deviceId === override) ?? null
      : initialPeerDeviceId !== undefined
        ? devices.find((d) => d.deviceId === initialPeerDeviceId) ?? null
        : peer ?? devices[0] ?? null;
  const canSend = target !== null && (text.trim() !== '' || files.length > 0) && !sending;

  const send = async () => {
    if (target === null || !canSend) return;
    setSending(true);
    setResult(null);
    try {
      await engine.send({ peerDeviceId: target.deviceId, text: text.trim() || undefined, files });
      setText('');
      setFiles([]);
      setResult({ tone: 'ok', title: `Sent to ${target.name}`, body: 'It will land in their Inbox in a moment.' });
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

  const pick = () => {
    if (!onPickFiles) return;
    // Swallowed: both native pickers resolve empty on Cancel, and a rejection
    // means the picker broke -- leaving the composer usable beats a red box.
    void onPickFiles().then((picked) => setFiles((f) => [...f, ...picked])).catch(() => {});
  };

  return (
    <View style={ui.screen}>
      <View style={ui.appbar}>
        <Text style={ui.appbarTitle}>Send</Text>
      </View>
      <ScrollView contentContainerStyle={ui.pad} keyboardShouldPersistTaps="handled">
        <View style={ui.stack}>
          <Text style={ui.sectionT}>Who is it for?</Text>
          {readError ? <Note tone="err" title="No device list" body={readError} testID="send-read-error" /> : null}
          {devices.length === 0 ? (
            <Empty
              title="No devices on this network"
              body="Both devices need to be on the same Wi-Fi. Open Daak on the other one, then come back."
            />
          ) : (
            <View style={ui.rail}>
              {devices.map((d) => {
                const on = target?.deviceId === d.deviceId;
                const presence = devicePresence(d.online);
                return (
                  <Pressable
                    key={d.deviceId}
                    accessibilityRole="button"
                    accessibilityLabel={'select-' + d.deviceId}
                    accessibilityState={{ selected: on }}
                    onPress={() => {
                      setOverride(d.deviceId);
                      onPeerChange?.(d);
                      setResult(null);
                    }}
                    style={[
                      ui.devchip,
                      on ? ui.devchipOn : null,
                      { opacity: d.online === false ? 0.5 : 1 },
                    ]}
                  >
                    <Text style={ui.devchipT} numberOfLines={1}>{d.name}</Text>
                    <Status tone={presence.tone} label={presence.label} />
                  </Pressable>
                );
              })}
            </View>
          )}
        </View>

        <View style={ui.stack}>
          <Text style={ui.sectionT}>What are you sending?</Text>
          <AttachmentPicker
            files={files}
            onPick={pick}
            onRemove={(p) => setFiles((f) => f.filter((x) => x !== p))}
          />
        </View>

        <View style={ui.stack}>
          <Text style={ui.label}>Or type a note</Text>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Message"
            placeholderTextColor="rgba(28, 28, 28, 0.4)"
            multiline
            style={[ui.input, { minHeight: 96, textAlignVertical: 'top' }]}
          />
        </View>

        <Btn
          variant="primary"
          block
          disabled={!canSend}
          testID="send"
          onPress={() => void send()}
          label={target === null ? 'Pick a device first' : `Send to ${target.name}`}
        />
        {result ? <Note tone={result.tone} title={result.title} body={result.body} testID="send-result" /> : null}
        <Note
          title="Straight across the room"
          body="Nothing goes to the internet. Both devices must stay on this Wi-Fi."
        />
      </ScrollView>
    </View>
  );
}
