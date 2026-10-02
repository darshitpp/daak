import React from 'react';
import { Image, Text, View } from 'react-native';
import { colors, radius, spacing, ui } from '../theme';

export function QrView({ uri, label }: { uri: string; label?: string }) {
  return (
    <View style={ui.stackSm} accessibilityLabel="pairing-qr">
      <View
        style={{
          alignSelf: 'center',
          padding: spacing.md,
          borderRadius: radius.md,
          backgroundColor: colors.paper,
          borderWidth: 1,
          borderColor: colors.border,
        }}
      >
        <Image source={{ uri }} style={{ width: 256, height: 256 }} resizeMode="contain" />
      </View>
      {label ? <Text style={[ui.hint, { textAlign: 'center' }]}>{label}</Text> : null}
    </View>
  );
}
