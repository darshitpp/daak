import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { QrView } from '../components/QrView';

export function PairingScreen({ role, qrUri, onScan, sas }: {
  role: 'host' | 'join'; qrUri: string; onScan: () => void; sas: string;
}) {
  return (
    <View>
      {role === 'host' ? <QrView uri={qrUri} label="Scan this on the other device" /> : null}
      {/* Spec 3.3 Mode A is ONE QR, ONE scan. Only the joiner scans, and only
          the host has a QR to scan -- a joiner never displays one, so a
          host-side scan control would be a dead affordance reading a code no
          device ever shows. The host arms from its own QR display instead. */}
      {role === 'join'
        ? <Pressable onPress={onScan} accessibilityLabel="scan"><Text>Scan</Text></Pressable>
        : null}
      <Text accessibilityLabel="sas">{sas}</Text>
    </View>
  );
}
