import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import type { DeviceInfo } from '@daak/core';
import { useEngine } from '../EngineContext';
import { DeviceCard } from '../components/DeviceCard';

export function DevicesScreen({ onSend }: { onSend?: (d: DeviceInfo) => void } = {}) {
  const engine = useEngine();
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [queueDepth, setQueueDepth] = useState<Record<string, number>>({});

  useEffect(() => {
    const refresh = () => void engine.devices().then(setDevices);
    refresh();
    return engine.on((e) => {
      if (e.type === 'outbox.queued') {
        setQueueDepth((q) => ({ ...q, [e.deviceId]: e.queued }));
      }
      if (e.type === 'device.state' || e.type === 'device.discovered') refresh();
    });
  }, [engine]);

  return (
    <View>
      {devices.map((d) => (
        <DeviceCard key={d.deviceId} device={d} queued={queueDepth[d.deviceId] ?? 0} onOpen={onSend} />
      ))}
    </View>
  );
}
