import React from 'react';
import { Pressable, Text, View } from 'react-native';

export type Tab = 'dashboard' | 'devices' | 'transfers' | 'history' | 'settings' | 'pair';

const TABS: Tab[] = ['dashboard', 'devices', 'transfers', 'history', 'settings', 'pair'];

export function TabBar({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  return (
    <View accessibilityRole="tablist">
      {TABS.map((t) => (
        <Pressable key={t} accessibilityRole="tab" onPress={() => onChange(t)}>
          <Text>{t}</Text>
        </Pressable>
      ))}
    </View>
  );
}
