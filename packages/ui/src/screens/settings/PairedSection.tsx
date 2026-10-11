import React, { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import type { DaakEvent, DeviceInfo } from '@daak/core';
import { useEngine } from '../../EngineContext';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { Avatar, Btn, Empty, Note, Section, Status, byPresence, deviceLabel, presenceOf } from '../../components/ds';
import { ui } from '../../theme';

const REFRESH_ON: ReadonlySet<DaakEvent['type']> = new Set<DaakEvent['type']>([
  'device.state',
  'device.discovered',
  'device.presence',
  'pairing.done',
  'pairing.revoked',
]);

// A failure only. A success is the toast "{name} unpaired".
type Feedback = { title: string; body: string } | null;

/**
 * The paired devices, each with Remove. A device that is not on the network is
 * listed too (the engine returns it as `offline`), so it can be removed.
 *
 * This component calls `revokePairing` itself and waits for the answer. The
 * host hook `onUnpair` runs after a success and must not revoke again.
 */
export function PairedSection({ onUnpair }: { onUnpair?: (d: DeviceInfo) => void }) {
  const engine = useEngine();
  const toast = useToast();
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [target, setTarget] = useState<DeviceInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Feedback>(null);

  const refresh = useCallback(() => {
    void engine.devices().then(
      (list) => setDevices(list.filter((d) => d.paired === true).sort(byPresence)),
      // A list that cannot be read keeps the last one. Remove stays honest:
      // the engine answers the revoke itself.
      () => {},
    );
  }, [engine]);

  useEffect(() => {
    refresh();
    return engine.on((e) => {
      if (REFRESH_ON.has(e.type)) refresh();
    });
  }, [engine, refresh]);

  const confirm = async () => {
    const d = target;
    // revoke_pairing waits up to 3 s for the peer, so a second tap can arrive.
    if (d === null || busy) return;
    setBusy(true);
    try {
      await engine.revokePairing(d.deviceId);
      onUnpair?.(d);
      setNote(null);
      toast.show(`${deviceLabel(d)} unpaired`);
      refresh();
    } catch (e) {
      setNote({
        title: 'Unpair did not work',
        body: e instanceof Error ? e.message : 'The engine refused the change.',
      });
    } finally {
      setBusy(false);
      setTarget(null);
    }
  };

  return (
    <Section title="Paired devices">
      {devices.length === 0 ? (
        <Empty title="No devices paired" body="Pair one on the Devices tab to start sending." />
      ) : (
        <View style={ui.list}>
          {devices.map((d) => {
            const view = presenceOf(d);
            return (
              <View key={d.deviceId} style={ui.listRow}>
                <Avatar letter={deviceLabel(d)} />
                <View style={ui.fill}>
                  <Text style={ui.rowTitle} numberOfLines={1}>{deviceLabel(d)}</Text>
                  <Status tone={view.tone} label={view.label} />
                </View>
                <Btn
                  label="Remove"
                  accessibilityLabel={`Remove ${deviceLabel(d)}`}
                  variant="ghost"
                  testID={`remove-${d.deviceId}`}
                  onPress={() => setTarget(d)}
                />
              </View>
            );
          })}
        </View>
      )}
      {note ? <Note tone="err" title={note.title} body={note.body} testID="paired-result" /> : null}
      <Sheet
        open={target !== null}
        title={target ? `Unpair ${deviceLabel(target)}?` : ''}
        onClose={() => setTarget(null)}
        actions={
          target ? (
            <>
              <Btn
                label={`Remove ${deviceLabel(target)}`}
                variant="danger"
                block
                disabled={busy}
                testID="confirm-remove"
                onPress={() => void confirm()}
              />
              <Btn label="Keep it" variant="ghost" block testID="keep-paired" onPress={() => setTarget(null)} />
            </>
          ) : null
        }
      >
        <Text style={ui.lead}>You will need to check the same number again to send anything to it later.</Text>
      </Sheet>
    </Section>
  );
}

