import React, { useEffect, useState } from 'react';
import { useCallback } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { DeviceInfo } from '@daak/core';
import { useEngine } from '../EngineContext';
import { DeviceCard } from '../components/DeviceCard';
import { Btn, Empty, Note, Section } from '../components/ds';
import { ui } from '../theme';

export function DashboardScreen({ onSend, onPair, onUnpair, onCompose, onCheckConnection }: {
  onSend?: (d: DeviceInfo) => void;
  onPair?: () => void;
  /**
   * R42g: drop a pairing. Shown on a PAIRED device only; a discovered peer
   * offers Pair instead, because the engine refuses a send to a peer that has
   * no pairing row.
   */
  onUnpair?: (d: DeviceInfo) => void;
  /**
   * The prototype's "Send to a device" primary action. Optional, and null by
   * default: a shell that cannot route to its own Send tab has no business
   * rendering a button that says Send and does nothing.
   */
  onCompose?: () => void;
  /**
   * The prototype's "A device you paired isn't showing? See what to check"
   * button, below the primary action (prototypes/index.html:988). Injected:
   * the screen does not know whether anybody is reachable, only the host that
   * owns the engine does.
   */
  onCheckConnection?: () => void;
} = {}) {
  const engine = useEngine();
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    void engine.devices().then(
      (list) => {
        setDevices(list);
        setError('');
      },
      (e: unknown) => setError(e instanceof Error ? e.message : 'the engine did not answer with a device list'),
    );
  }, [engine]);

  useEffect(() => {
    refresh();
    return engine.on((e) => {
      if (e.type === 'device.state' || e.type === 'device.discovered') refresh();
    });
  }, [engine, refresh]);

  return (
    <View style={ui.screen}>
      <View style={ui.appbar}>
        <Text style={ui.appbarTitle}>Devices</Text>
        <Btn label="Refresh" variant="ghost" onPress={refresh} testID="devices-refresh" />
        {onPair ? <Btn label="Pair a device" variant="ghost" onPress={onPair} testID="pair-a-device" /> : null}
      </View>
      <ScrollView contentContainerStyle={ui.pad}>
        <Section title="On this network">
          {error ? <Note tone="err" title="No device list" body={error} testID="devices-error" /> : null}
          {devices.length === 0 ? (
            <Empty
              title="No devices yet"
              body="Open Daak on the other device, then pair it. Both devices must be on the same Wi-Fi."
              action={onPair ? <Btn label="Pair a device" onPress={onPair} /> : undefined}
            />
          ) : (
            <View style={ui.list}>
              {devices.map((d) => (
                <DeviceCard
                  key={d.deviceId}
                  device={d}
                  onSend={onSend}
                  onPair={onPair}
                  onUnpair={onUnpair}
                />
              ))}
            </View>
          )}
        </Section>
        {/* The prototype's primary action, in its own block ABOVE the list
            (prototypes/index.html:987). Routed by the host rather than set here:
            this screen is handed devices, not the tab state. */}
        {onCompose ? (
          <Btn label="Send to a device" variant="primary" block onPress={onCompose} testID="devices-send" />
        ) : null}
        {onCheckConnection ? (
          <Btn
            variant="quiet"
            block
            label="A device you paired isn't showing? See what to check"
            testID="devices-check-connection"
            onPress={onCheckConnection}
          />
        ) : null}
        <Note
          title="Everyone here is on the same Wi-Fi"
          body="Tap Send on a device to put something in its Inbox. Nothing leaves the network."
        />
      </ScrollView>
    </View>
  );
}
