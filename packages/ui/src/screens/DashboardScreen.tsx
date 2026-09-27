import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import type { DeviceInfo, InboxEntry } from '@daak/core';
import { useEngine } from '../EngineContext';
import { DeviceCard } from '../components/DeviceCard';

export function DashboardScreen() {
  const engine = useEngine();
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [inbox, setInbox] = useState<InboxEntry[]>([]);

  useEffect(() => {
    void engine.devices().then(setDevices);
    void engine.listInbox().then(setInbox);
    return engine.on((e) => {
      if (e.type === 'device.state') void engine.devices().then(setDevices);
      if (e.type === 'inbox.received') setInbox((prev) => [e.payload, ...prev]);
    });
  }, [engine]);

  return (
    <View>
      {devices.map((d) => <DeviceCard key={d.deviceId} device={d} onSend={() => {}} />)}
      {inbox.map((i) => <Text key={i.payloadId}>{i.summary}</Text>)}
    </View>
  );
}
