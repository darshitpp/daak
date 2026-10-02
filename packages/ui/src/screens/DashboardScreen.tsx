import React, { useEffect, useState } from 'react';
import { useCallback } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { DeviceInfo } from '@daak/core';
import { useEngine } from '../EngineContext';
import { DeviceCard } from '../components/DeviceCard';
import { Btn, Empty, Note, Section } from '../components/ds';
import { ui } from '../theme';

export function DashboardScreen({ onSend, onPair }: {
  onSend?: (d: DeviceInfo) => void;
  onPair?: () => void;
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
                <DeviceCard key={d.deviceId} device={d} onSend={onSend} />
              ))}
            </View>
          )}
        </Section>
        <Note
          title="Everyone here is on the same Wi-Fi"
          body="Tap Send on a device to put something in its Inbox. Nothing leaves the network."
        />
      </ScrollView>
    </View>
  );
}
