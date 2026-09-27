import React from 'react';
import { Pressable, Text, View } from 'react-native';
import type { DeviceInfo } from '@daak/core';

/**
 * `onSend` is OPTIONAL and the button renders only when it is supplied, the same
 * way ReceivedItemRow hides Retry: a visible Pressable wired to a no-op is a
 * dead button in the shipped UI, which is worse than no button (R37/R128).
 * apps/mobile supplies a real one (it opens the composer); nothing in the tree
 * passes an empty callback.
 */
export function DeviceCard({ device, onSend }: { device: DeviceInfo; onSend?: (d: DeviceInfo) => void }) {
  return (
    <View>
      <Text>{device.name}</Text>
      <Text>{device.online ? 'online' : 'offline'}</Text>
      {onSend ? (
        <Pressable onPress={() => onSend(device)} accessibilityLabel={`send-to-${device.deviceId}`}>
          <Text>Send</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
