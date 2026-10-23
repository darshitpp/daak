import React, { useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Btn, Note } from '../../components/ds';
import { colors, radius, spacing, type, ui } from '../../theme';
import { ABOUT_LINKS, RELEASES_URL } from '../about-links';

type Info = { version: string; build: string };

/**
 * `appInfo` is async (P2). The Version row shows only after the host answers.
 * A reject, a sync throw, or `version: 'unknown'` (the P2 fallback) hides it.
 */
export function AboutSection({ appInfo }: { appInfo?: () => Promise<Info> }) {
  const [expanded, setExpanded] = useState(true);
  const [failed, setFailed] = useState(false);
  const [info, setInfo] = useState<Info | null>(null);
  useEffect(() => {
    if (appInfo === undefined) return undefined;
    let alive = true;
    void Promise.resolve()
      .then(appInfo)
      .then(
        (i) => alive && setInfo(i.version === 'unknown' ? null : i),
        () => alive && setInfo(null),
      );
    return () => {
      alive = false;
    };
  }, [appInfo]);
  // The call may throw at once or reject later. Both mean "no browser".
  const open = (url: string) => {
    setFailed(false);
    try {
      void Promise.resolve(Linking.openURL(url)).catch(() => setFailed(true));
    } catch {
      setFailed(true);
    }
  };
  return (
    <View style={ui.stack}>
      <View style={styles.box}>
        <Pressable
          testID="about-toggle"
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((e) => !e)}
          style={({ pressed }) => [styles.header, pressed ? ui.pressed : null]}
        >
          <Text style={styles.title}>About Daak</Text>
          <Chevron expanded={expanded} />
        </Pressable>
        {expanded ? (
          <View style={styles.content}>
            <View style={ui.cardTight} testID="about-facts">
              <View style={[ui.kv, ui.kvFirst]}>
                <Text style={ui.kvK}>Works on</Text>
                <Text style={ui.kvV}>This Wi-Fi only</Text>
              </View>
              <View style={ui.kv}>
                <Text style={ui.kvK}>Account needed</Text>
                <Text style={ui.kvV}>No account, none</Text>
              </View>
              <View style={ui.kv}>
                <Text style={ui.kvK}>Where files are kept</Text>
                <Text style={ui.kvV}>On your devices</Text>
              </View>
              {info ? (
                <View style={ui.kv}>
                  <Text style={ui.kvK}>Version</Text>
                  <Text style={[ui.kvV, ui.nowrap]}>{`Version ${info.version} (build ${info.build})`}</Text>
                </View>
              ) : null}
            </View>
            <View style={ui.cardTight} testID="about-links">
              {ABOUT_LINKS.map((l, i) => (
                <Pressable
                  key={l.id}
                  testID={`about-link-${l.id}`}
                  accessibilityRole="link"
                  accessibilityLabel={`${l.label} ${l.handle}`}
                  onPress={() => open(l.url)}
                  style={({ pressed }) => [ui.kv, i === 0 ? ui.kvFirst : null, { minHeight: 44 }, pressed ? ui.pressed : null]}
                >
                  <Text style={ui.kvK}>{l.label}</Text>
                  <Text style={ui.kvV}>{l.handle}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}
      </View>
      <View style={ui.row}>
        <Text style={[ui.hint, ui.fill]}>See whether Daak needs an update</Text>
        <Btn label="Check for updates" variant="quiet" size="sm" testID="check-for-updates" onPress={() => open(RELEASES_URL)} />
      </View>
      {failed ? (
        <Note tone="warn" title="The link did not open" body="This device has no app that can open web links." testID="about-open-error" />
      ) : null}
    </View>
  );
}

// The design chevron (a 24 unit viewBox, stroke 1.75). react-native-svg is not
// a dependency of this package, so View borders draw it, as TabBar does.
function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <View
      testID="about-chevron"
      style={styles.chevronBox}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View style={[styles.chevron, { transform: [{ rotate: expanded ? '45deg' : '-45deg' }] }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, backgroundColor: colors.surface, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, minHeight: 44, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  // The prototype `.section-t` class with the weight of `.section-t-btn`.
  title: { fontSize: type.sm, fontWeight: '600', color: colors.muted },
  content: { gap: spacing.md, padding: spacing.md, borderTopWidth: 1, borderTopColor: colors.border },
  chevronBox: { width: 16, height: 16, alignItems: 'center', justifyContent: 'center' },
  chevron: { width: 8, height: 8, marginTop: -3, borderRightWidth: 1.75, borderBottomWidth: 1.75, borderColor: colors.fg },
});
