import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { ui } from '../theme';

/**
 * The five destinations the Open Design prototypes actually ship. Pairing is
 * NOT one of them: it is a route out of Devices, so a six-item bar would be
 * wider than the phone allows and wider than the sidebar needs.
 */
export type Tab = 'send' | 'devices' | 'history' | 'transfers' | 'settings' | 'pair';

const TABS: { id: Tab; label: string; glyph: string }[] = [
  { id: 'send', label: 'Send', glyph: '↑' },
  { id: 'devices', label: 'Devices', glyph: '▣' },
  { id: 'history', label: 'Inbox', glyph: '✉' },
  { id: 'transfers', label: 'Transfers', glyph: '⇄' },
  { id: 'settings', label: 'Settings', glyph: '⚙' },
];

function TabButton({ tab, on, onChange, layout }: {
  tab: { id: Tab; label: string; glyph: string };
  on: boolean;
  onChange: (t: Tab) => void;
  layout: 'mobile' | 'desktop';
}) {
  const desktop = layout === 'desktop';
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: on }}
      onPress={() => onChange(tab.id)}
      style={({ pressed }) => [
        desktop ? ui.sideitem : ui.tab,
        on ? (desktop ? ui.sideitemOn : ui.tabOn) : null,
        pressed ? ui.pressed : null,
      ]}
    >
      {desktop ? null : <Text style={[ui.tabGlyph, on ? ui.tabGlyphOn : null]}>{tab.glyph}</Text>}
      <Text style={desktop ? [ui.sideLabel, on ? ui.sideLabelOn : null] : [ui.tabLabel, on ? ui.tabLabelOn : null]}>
        {tab.label}
      </Text>
    </Pressable>
  );
}

export function TabBar({ tab, onChange, layout = 'mobile' }: {
  tab: Tab;
  onChange: (t: Tab) => void;
  layout?: 'mobile' | 'desktop';
}) {
  if (layout === 'desktop') {
    return (
      <View style={ui.sidenav} accessibilityRole="tablist">
        {TABS.map((t) => (
          <TabButton key={t.id} tab={t} on={tab === t.id} onChange={onChange} layout="desktop" />
        ))}
      </View>
    );
  }
  return (
    <View style={ui.tabbar} accessibilityRole="tablist">
      {TABS.map((t) => (
        <TabButton key={t.id} tab={t} on={tab === t.id} onChange={onChange} layout="mobile" />
      ))}
    </View>
  );
}

export const TAB_LABELS = TABS.map((t) => t.label);
