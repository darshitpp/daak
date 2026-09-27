import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { QrView } from '../components/QrView';

export function PairingScreen({ role, qrUri, onScan, sas }: {
  role: 'host' | 'join'; qrUri: string; onScan: () => void; sas: string;
}) {
  return (
    <View>
      {role === 'host' ? <QrView uri={qrUri} label="Scan this on the other device" /> : null}
      {role === 'join'
        ? <Pressable onPress={onScan} accessibilityLabel="scan"><Text>Scan</Text></Pressable>
        : null}
      <Text accessibilityLabel="sas">{sas}</Text>
    </View>
  );
}
