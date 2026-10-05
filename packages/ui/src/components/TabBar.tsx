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
      // `button`, NOT `tab`. React Native maps `tab` to UIAccessibilityTraitNone
      // on iOS (RCTViewManager.m), exactly like `none`: a trait of None is not
      // an accessibility element, so the destination never reaches VoiceOver
      // or any automation surface. A tab IS a control the user activates, and
      // accessibilityState.selected carries the tab meaning on top of it.
      accessibilityRole="button"
      // A role alone is not a name. Without the label the control is announced
      // as an unlabelled button.
      accessibilityLabel={tab.label}
      // The Inbox destination is the `history` SLOT, so the id comes from the
      // label. `tab-history` would name a destination the user never sees.
      testID={`tab-${tab.label.toLowerCase()}`}
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
      // The rail carries NO accessibilityRole. `tabbar` is an iOS-only trait
      // (RCTViewManager.m). The Android AccessibilityRole enum has no TABBAR
      // member, so fromValue throws IllegalArgumentException and Android shows
      // a redbox. No container role both groups on iOS and survives Android,
      // and this package must hold no platform conditional.
      <View style={ui.sidenav}>
        {TABS.map((t) => (
          <TabButton key={t.id} tab={t} on={tab === t.id} onChange={onChange} layout="desktop" />
        ))}
      </View>
    );
  }
  return (
    // The rail carries NO accessibilityRole, for the same reason as the
    // desktop rail above.
    <View style={ui.tabbar}>
      {TABS.map((t) => (
        <TabButton key={t.id} tab={t} on={tab === t.id} onChange={onChange} layout="mobile" />
      ))}
    </View>
  );
}

export const TAB_LABELS = TABS.map((t) => t.label);
