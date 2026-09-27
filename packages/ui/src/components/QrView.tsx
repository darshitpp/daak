import React from 'react';
import { Image, Text, View } from 'react-native';

export function QrView({ uri, label }: { uri: string; label?: string }) {
  return (
    <View accessibilityLabel="pairing-qr">
      <Image source={{ uri }} style={{ width: 256, height: 256 }} />
      {label ? <Text>{label}</Text> : null}
    </View>
  );
}
