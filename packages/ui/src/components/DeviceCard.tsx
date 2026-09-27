import React from 'react';
import { Pressable, Text, View } from 'react-native';
import type { DeviceInfo } from '@daak/core';

export function DeviceCard({ device, onSend }: { device: DeviceInfo; onSend: (d: DeviceInfo) => void }) {
  return (
    <View>
      <Text>{device.name}</Text>
      <Text>{device.online ? 'online' : 'offline'}</Text>
      <Pressable onPress={() => onSend(device)} accessibilityLabel={`send-to-${device.deviceId}`}>
        <Text>Send</Text>
      </Pressable>
    </View>
  );
}
