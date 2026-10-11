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

function Tabs({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
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
              ui.tab,
              on ? ui.tabOn : null,
              pressed ? ui.pressed : null,
            ]}
          >
            <TabIcon kind={t.id} color={on ? colors.fg : colors.muted} />
            <Text style={[ui.tabLabel, on ? ui.tabLabelOn : null]}>{t.label}</Text>
          </Pressable>
        );
      })}
    </>
  );
}

export function TabBar({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  return (
    <View style={ui.tabbar}>
      <Tabs tab={tab} onChange={onChange} />
    </View>
  );
}

/**
 * The macOS window sidebar (design `macos.html`, `.sidebar`).
 *
 * The window draws it on EVERY route, so the user can leave a thread, a
 * pairing, or Settings at any time. `active` is the highlight: the thread, the
 * pair route, and the held route all highlight Devices (design NAV_FOR). The
 * footer holds the version line the host reads from `appInfo`.
 */
export function Sidebar({ active, onChange, version }: {
  active: Tab;
  onChange: (t: Tab) => void;
  version?: string;
}) {
  return (
    <View style={ui.sidebar} testID="window-sidebar">
      <View style={ui.sidebarBrand}>
        <Wordmark />
      </View>
      <View style={ui.sidebarNav}>
        {TABS.map((t) => {
          const on = active === t.id;
          return (
            <Pressable
              key={t.id}
              accessibilityRole="button"
              accessibilityLabel={t.label}
              accessibilityState={{ selected: on }}
              testID={'side-' + t.id}
              onPress={() => onChange(t.id)}
              style={({ pressed }) => [
                ui.sidebarItem,
                on ? ui.sidebarItemOn : null,
                pressed ? ui.pressed : null,
              ]}
            >
              <TabIcon kind={t.id} color={on ? colors.fg : colors.fg2} />
              <Text style={[ui.sidebarItemTxt, on ? ui.sidebarItemTxtOn : null]}>{t.label}</Text>
            </Pressable>
          );
        })}
      </View>
      {version ? <Text style={ui.sidebarFoot}>{version}</Text> : null}
    </View>
  );
}

