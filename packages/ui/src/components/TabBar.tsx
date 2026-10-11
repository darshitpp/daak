import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, ui } from '../theme';
import { Wordmark } from './ds';

/**
 * The two destinations the design ships. Thread, pair, and held are routes
 * above these, owned by AppShell. They are not tabs.
 */
export type Tab = 'devices' | 'settings';

const TABS: { id: Tab; label: string }[] = [
  { id: 'devices', label: 'Devices' },
  { id: 'settings', label: 'Settings' },
];

// Design tabbar: two SVG icons, not glyphs. react-native-svg is not a
// dependency of this package, so the two shapes are drawn with View elements
// at the design geometry. Every number below is a design unit (the viewBox is
// 24) multiplied by ICON_K.
const ICON = 20; // the design .ic box is 20 by 20
const ICON_K = ICON / 24;
const STROKE = 1.75 * ICON_K; // design stroke-width 1.75
const SPOKE_R = 8 * ICON_K; // a spoke midpoint, 8 units from the centre
const SPOKE_LEN = 2 * ICON_K; // a spoke runs from radius 9 to radius 7
const SPOKES = [0, 45, 90, 135, 180, 225, 270, 315];

/** The design icon of one tab, in one colour. */
function TabIcon({ kind, color }: { kind: Tab; color: string }) {
  const edge = { borderColor: color, borderWidth: STROKE, position: 'absolute' as const };
  if (kind === 'devices') {
    // index.html tabbar: a laptop screen, its base line, and a phone beside it.
    return (
      <View style={styles.icon} testID="tab-icon-devices" pointerEvents="none">
        <View style={[edge, { left: 3 * ICON_K, top: 4 * ICON_K, width: 12 * ICON_K, height: 10 * ICON_K, borderRadius: 2 * ICON_K }]} />
        <View style={{ position: 'absolute', left: 8 * ICON_K, top: 17.125 * ICON_K, width: 2 * ICON_K, height: STROKE, backgroundColor: color }} />
        <View style={[edge, { left: 18 * ICON_K, top: 8 * ICON_K, width: 3 * ICON_K, height: 9 * ICON_K }]} />
      </View>
    );
  }
  // index.html tabbar: a ring with eight spokes.
  return (
    <View style={styles.icon} testID="tab-icon-settings" pointerEvents="none">
      <View style={[edge, { left: 9 * ICON_K, top: 9 * ICON_K, width: 6 * ICON_K, height: 6 * ICON_K, borderRadius: 3 * ICON_K }]} />
      {SPOKES.map((deg) => {
        const rad = (deg * Math.PI) / 180;
        return (
          <View
            key={deg}
            style={{
              position: 'absolute',
              left: 12 * ICON_K + SPOKE_R * Math.cos(rad) - SPOKE_LEN / 2,
              top: 12 * ICON_K + SPOKE_R * Math.sin(rad) - STROKE / 2,
              width: SPOKE_LEN,
              height: STROKE,
              backgroundColor: color,
              transform: [{ rotate: deg + 'deg' }],
            }}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  icon: { width: ICON, height: ICON },
});

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
            {desktop ? null : <TabIcon kind={t.id} color={on ? colors.fg : colors.muted} />}
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

