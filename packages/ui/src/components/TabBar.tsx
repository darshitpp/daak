import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { colors, ui } from '../theme';
import { Wordmark } from './ds';

/**
 * The two destinations the design ships. Thread, pair, and held are routes
 * above these, owned by AppShell. They are not tabs.
 */
export type Tab = 'devices' | 'settings';

const TABS: { id: Tab; label: string; glyph: string }[] = [
  { id: 'devices', label: 'Devices', glyph: '▣' },
  { id: 'settings', label: 'Settings', glyph: '⚙' },
];

function Tabs({ tab, onChange, layout }: { tab: Tab; onChange: (t: Tab) => void; layout: 'mobile' | 'desktop' }) {
  const desktop = layout === 'desktop';
  return (
    <>
      {TABS.map((t) => {
        const on = tab === t.id;
        return (
          <Pressable
            key={t.id}
            // `button`, not `tab`. React Native maps `tab` to
            // UIAccessibilityTraitNone on iOS, so the control never reaches
            // VoiceOver. `selected` carries the tab meaning.
            accessibilityRole="button"
            accessibilityLabel={t.label}
            testID={`tab-${t.label.toLowerCase()}`}
            accessibilityState={{ selected: on }}
            onPress={() => onChange(t.id)}
            style={({ pressed }) => [
              desktop ? ui.segTab : ui.tab,
              on ? (desktop ? ui.segItemOn : ui.tabOn) : null,
              pressed ? ui.pressed : null,
            ]}
          >
            {desktop ? null : <Text style={[ui.tabGlyph, on ? ui.tabGlyphOn : null]}>{t.glyph}</Text>}
            <Text
              style={
                desktop
                  ? { fontSize: 14, color: on ? colors.onAccent : colors.fg }
                  : [ui.tabLabel, on ? ui.tabLabelOn : null]
              }
            >
              {t.label}
            </Text>
          </Pressable>
        );
      })}
    </>
  );
}

export function TabBar({ tab, onChange, layout = 'mobile', title, trailing }: {
  tab: Tab;
  onChange: (t: Tab) => void;
  layout?: 'mobile' | 'desktop';
  title?: string;
  trailing?: string;
}) {
  if (layout === 'desktop') {
    // No accessibilityRole on the containers. `tabbar` exists on iOS only, and
    // the Android enum has no TABBAR member, so fromValue would throw.
    return (
      <View style={ui.deskbar}>
        <View testID="window-wordmark"><Wordmark size="sm" /></View>
        <Text style={ui.deskTitle} accessibilityRole="header">{title ?? ''}</Text>
        <View style={ui.seg}>
          <Tabs tab={tab} onChange={onChange} layout="desktop" />
        </View>
        {trailing ? <Text style={ui.deskVer}>{trailing}</Text> : null}
      </View>
    );
  }
  return (
    <View style={ui.tabbar}>
      <Tabs tab={tab} onChange={onChange} layout="mobile" />
    </View>
  );
}

export const TAB_LABELS = TABS.map((t) => t.label);

