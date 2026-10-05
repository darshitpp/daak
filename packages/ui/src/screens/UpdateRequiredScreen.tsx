import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { AppBar, Hero, KvCard, ONB_GLYPHS } from '../components/Onboarding';
import { Btn, Note } from '../components/ds';
import { ui } from '../theme';
import type { IncompatiblePeer } from '../state/store';

/**
 * The prototype's update-required screen (sc-update-required).
 *
 * THE OTHER SCREEN WHOSE PROTOTYPE NUMBERS ARE ALL LIES. The prototype's card
 * reads "Version 0.4.2 (build 1180)" against "Version 0.5.0 (build 1244)", and
 * its progress row animates through "Starting / Downloading / Almost done"
 * before claiming "Version 0.5.0 (build 1244). You can send again." None of
 * that exists: there is no updater, no download, no build number, and the
 * engine's own version is a single u16 manifest version (currently 1), not a
 * semver triple. A screen that animates a fake download to a fake version is
 * the single most damaging thing this integration could ship.
 *
 * So this screen reports the two REAL numbers the engine actually sends --
 * the peer's advertised protocol version and this build's manifest version --
 * and offers exactly the two things that exist: dismiss, and open Settings
 * where a real update would come from. The advice even branches on which side
 * is behind, because those need different words and the event carries both
 * numbers for exactly that reason.
 */
export function UpdateRequiredScreen({
  peers,
  onDismiss,
  onOpenSettings,
  onBack,
}: {
  /** Every peer currently announcing a version this build refuses. */
  peers: IncompatiblePeer[];
  onDismiss: () => void;
  onOpenSettings: () => void;
  onBack?: () => void;
}) {
  const first = peers[0];
  // Two directions, two different problems. peer > ours means THEY moved on
  // and this build is the old one; peer < ours means this build moved on and
  // they have not. Saying "update Daak" for the second is wrong advice that
  // would make the user update something already current.
  const theyAreNewer = first !== undefined && first.peerVersion > first.ourVersion;
  return (
    <View style={ui.screen} testID="screen-update-required">
      <AppBar title="Update needed" onBack={onBack} backLabel="Back to Settings" />
      <ScrollView contentContainerStyle={ui.pad}>
        <Hero
          glyph={ONB_GLYPHS.update}
          title="Daak needs a quick update"
          lead={
            theyAreNewer
              ? 'The part of Daak that moves your files is newer than this app. Update the app to go back to sending.'
              : 'This app is newer than the Daak on another device. Update that one to pair with each other again.'
          }
        />

        {first === undefined ? null : (
          <KvCard
            rows={[
              { k: 'This app', v: `File mover version ${first.ourVersion}`, nowrap: true },
              { k: first.peerName, v: `File mover version ${first.peerVersion}`, nowrap: true },
            ]}
          />
        )}

        <Note
          tone="warn"
          title="Sending and receiving are paused"
          body="Your paired devices and everything already in your Inbox are safe."
        />

        {peers.length < 2 ? null : (
          <View style={ui.stackSm}>
            <Text style={ui.sectionT}>Also out of step</Text>
            {peers.slice(1).map((p) => (
              <View key={p.peerDeviceId} style={[ui.kv, ui.kvFirst]} testID="update-required-peer">
                <Text style={ui.kvK}>{p.peerName}</Text>
                <Text style={[ui.kvV, ui.nowrap]}>{'File mover version ' + p.peerVersion}</Text>
              </View>
            ))}
          </View>
        )}

        <View style={ui.stackSm}>
          <Btn variant="primary" block label="Open Settings to update" testID="update-settings" onPress={onOpenSettings} />
          <Btn variant="ghost" block label="Remind me later" testID="update-dismiss" onPress={onDismiss} />
          <Text style={ui.hint}>
            Daak has no updater of its own. Update through wherever you installed it.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}
