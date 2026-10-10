import React, { useEffect, useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { Btn, Note, Section } from '../../components/ds';
import { ui } from '../../theme';
import { ABOUT_LINKS, RELEASES_URL } from '../about-links';

type Info = { version: string; build: string };

/**
 * `appInfo` is async (P2). The Version row shows only after the host answers.
 * A reject, a sync throw, or `version: 'unknown'` (the P2 fallback) hides it.
 */
export function AboutSection({ appInfo }: { appInfo?: () => Promise<Info> }) {
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
    <Section title="About Daak">
      <View style={ui.card}>
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
        {ABOUT_LINKS.map((l) => (
          <Pressable
            key={l.id}
            testID={`about-link-${l.id}`}
            accessibilityRole="link"
            accessibilityLabel={`${l.label} ${l.handle}`}
            onPress={() => open(l.url)}
            style={({ pressed }) => [ui.kv, { minHeight: 44 }, pressed ? ui.pressed : null]}
          >
            <Text style={ui.kvK}>{l.label}</Text>
            <Text style={ui.kvV}>{l.handle}</Text>
          </Pressable>
        ))}
        <View style={ui.kv}>
          <Text style={[ui.kvK, ui.fill]}>See whether Daak needs an update</Text>
          <Btn label="Check for updates" variant="quiet" testID="check-for-updates" onPress={() => open(RELEASES_URL)} />
        </View>
      </View>
      {failed ? (
        <Note tone="warn" title="The link did not open" body="This device has no app that can open web links." testID="about-open-error" />
      ) : null}
    </Section>
  );
}

