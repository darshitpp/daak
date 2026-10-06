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
export function DeviceCard({ device, onSend, onPair, onUnpair }: {
  device: DeviceInfo;
  onSend?: (d: DeviceInfo) => void;
  /** Open the pairing route. A discovered peer is not trusted yet. */
  onPair?: () => void;
  /** R42g: drop the pairing. Shown only for a paired peer. */
  onUnpair?: (d: DeviceInfo) => void;
}) {
  const presence = devicePresence(device.online);
  // Undefined means an engine that predates the flag, and the safe reading is
  // "not paired": the engine refuses a send to an unpaired peer, so offering
  // Send would be the dead button this component already avoids.
  const paired = device.paired === true;
  return (
    <View style={ui.listRow}>
      <Avatar letter={device.name} />
      <View style={ui.fill}>
        <Text style={ui.rowTitle} numberOfLines={1}>{device.name}</Text>
        <Status tone={paired ? presence.tone : 'off'} label={paired ? presence.label : 'Not paired'} />
      </View>
      {paired && onSend ? (
        <Btn label="Send" onPress={() => onSend(device)} testID={`send-to-${device.deviceId}`} />
      ) : null}
      {!paired && onPair ? (
        <Btn label="Pair" onPress={onPair} testID={`pair-with-${device.deviceId}`} />
      ) : null}
      {paired && onUnpair ? (
        <Btn
          label="Unpair"
          variant="ghost"
          onPress={() => onUnpair(device)}
          testID={`unpair-${device.deviceId}`}
        />
      ) : null}
    </View>
  );
}
