import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { QrView } from '../components/QrView';
import { Btn, Note, Section } from '../components/ds';
import { ui } from '../theme';

export function PairingScreen({ role, qrUri, onScan, sas, onReject, embedded = false }: {
  role: 'host' | 'join';
  qrUri: string;
  onScan: () => void;
  sas: string;
  /**
   * The engine stores the pairing before the user sees the SAS, so a SAS that
   * does not match must remove it. The control shows only with a SAS on screen.
   */
  onReject?: () => void;
  /**
   * Drop this screen's own appbar and scroll container, because a host is
   * already drawing both. Onboarding's Pair First Device step supplies the
   * appbar, the step counter and the column, and rendering a second appbar
   * inside it produces a screen nested in a screen.
   *
   * The CONTENT is untouched either way: same real QR, same real scan control,
   * same real SAS, same notes. Only the frame is suppressed, because the frame
   * is the half the host already owns.
   */
  embedded?: boolean;
}) {
  const body = (
    <>
        {role === 'host' ? (
          <Section title="Show this to the other device">
            <QrView uri={qrUri} label="Point their camera at this square." />
          </Section>
        ) : null}
        {/* Spec 3.3 Mode A is ONE QR, ONE scan. Only the joiner scans, and only
            the host has a QR to scan -- a joiner never displays one, so a
            host-side scan control would be a dead affordance reading a code no
            device ever shows. The host arms from its own QR display instead. */}
        {role === 'join' ? <Btn label="Scan their code" onPress={onScan} testID="scan" block /> : null}
        {sas ? (
          <View style={ui.card}>
            <Text style={ui.sectionT}>Read this out loud. Both screens must match.</Text>
            <Text style={ui.verify} accessibilityLabel="sas">{sas}</Text>
          </View>
        ) : null}
        {sas && onReject ? (
          <Btn variant="quiet" block testID="reject" label="Does not match - remove" onPress={onReject} />
        ) : null}
        <Note
          title="Both devices need to be on the same Wi-Fi"
          body="Pairing never touches the internet. Read the number out loud on both devices before you accept."
        />
        <Text style={ui.hint}>
          That number is derived from both devices' keys. If it does not match, stop and pair again.
        </Text>
    </>
  );
  if (embedded) return <View style={ui.stack}>{body}</View>;
  return (
    <View style={ui.screen}>
      <View style={ui.appbar}>
        <Text style={ui.appbarTitle}>Pair a device</Text>
      </View>
      <ScrollView contentContainerStyle={ui.pad}>{body}</ScrollView>
    </View>
  );
}
