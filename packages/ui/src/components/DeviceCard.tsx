import React from 'react';
import { Text, View } from 'react-native';
import type { DeviceInfo } from '@daak/core';
import { Avatar, Btn, Status, devicePresence } from './ds';
import { ui } from '../theme';

/**
 * `onSend` is OPTIONAL and the button renders only when it is supplied, the
 * same way ReceivedItemRow hides Retry: a visible Pressable wired to a no-op is
 * a dead button in the shipped UI, which is worse than no button.
 *
 * The status line is three-state because the engine is: `online` is undefined
 * on a cold daemon, and printing "offline" there is a reachability claim the
 * engine never makes (a send to an unknown-liveness peer queues and succeeds).
 */
export function DeviceCard({ device, onSend }: { device: DeviceInfo; onSend?: (d: DeviceInfo) => void }) {
  const presence = devicePresence(device.online);
  return (
    <View style={ui.listRow}>
      <Avatar letter={device.name} />
      <View style={ui.fill}>
        <Text style={ui.rowTitle} numberOfLines={1}>{device.name}</Text>
        <Status tone={presence.tone} label={presence.label} />
      </View>
      {onSend ? (
        <Btn label="Send" onPress={() => onSend(device)} testID={`send-to-${device.deviceId}`} />
      ) : null}
    </View>
  );
}
