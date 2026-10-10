import React from 'react';
import { Pressable, Text, View } from 'react-native';
import type { DeviceInfo } from '@daak/core';
import { Avatar, Btn, Status, deviceLabel, presenceOf } from './ds';
import { ui } from '../theme';

/**
 * One device row. A paired device is a button that opens its conversation.
 * The engine queues a send to an offline peer, so every paired row is
 * selectable. Send and Unpair are not on the row: the thread sends, and
 * Settings unpairs.
 *
 * `paired` undefined means an engine that predates the flag. The safe reading
 * is "not paired": the engine refuses a send to an unpaired peer.
 *
 * `openLabel` replaces the accessibility label of the row. The menu-bar panel
 * passes its own until plan P4 rewrites that panel.
 */
export function DeviceCard({ device, queued = 0, onOpen, onPair, openLabel }: {
  device: DeviceInfo;
  /** Unsent outbox rows for this peer. The badge shows only above zero. */
  queued?: number;
  onOpen?: (d: DeviceInfo) => void;
  /** Open the pairing route. A discovered peer is not trusted yet. */
  onPair?: () => void;
  openLabel?: string;
}) {
  const paired = device.paired === true;
  const label = deviceLabel(device);
  const view = presenceOf(device);
  const body = (
    <>
      <Avatar letter={label} />
      <View style={ui.fill}>
        <Text style={ui.rowTitle} numberOfLines={1}>{label}</Text>
        <Status tone={paired ? view.tone : 'off'} label={paired ? view.label : 'Not paired yet'} />
        {paired && queued > 0 ? <Text style={ui.hint}>{queued + ' waiting'}</Text> : null}
      </View>
      {!paired && onPair ? (
        <Btn label="Pair" onPress={onPair} testID={`pair-with-${device.deviceId}`} />
      ) : null}
    </>
  );
  if (paired && onOpen) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={openLabel ?? `Open conversation with ${label}`}
        testID={`open-${device.deviceId}`}
        onPress={() => onOpen(device)}
        style={({ pressed }) => [ui.listRow, pressed ? ui.pressed : null]}
      >
        {body}
      </Pressable>
    );
  }
  return <View style={ui.listRow}>{body}</View>;
}

