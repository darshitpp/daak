import React from 'react';
import { Text, View } from 'react-native';

export function ProgressRow({ name, bytesDone, bytesTotal, state }: {
  name: string; bytesDone: number; bytesTotal: number; state: string;
}) {
  const pct = bytesTotal > 0 ? Math.floor((bytesDone / bytesTotal) * 100) : 0;
  return (
    <View accessibilityRole="summary">
      <Text>{name}</Text>
      <Text>{pct}%</Text>
      <Text>{state}</Text>
    </View>
  );
}
