import React from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { QrView } from '../components/QrView';
import { Accordion } from '../components/Onboarding';
import { Btn, Note } from '../components/ds';
import { colors, ui } from '../theme';
import { formatSas } from './sas';

function Busy({ label }: { label: string }) {
  return (
    <View style={ui.row} testID="pairing-busy">
      <ActivityIndicator color={colors.muted} />
      <Text style={ui.progN}>{label}</Text>
    </View>
  );
}

/**
 * The pairing panels (design routes `pair-first-device`, `pair-show-panel`,
 * `pair-scan-panel`, `pair-error`).
 *
 * The host shows a QR and then the number. The joiner scans, reads, and then
 * shows the number. `busy` and `error` come from the flow that owns the engine
 * calls. This screen only draws them.
 *
 * The number is grouped by `formatSas`. The sentence in the expander uses the
 * same grouped text as the big number.
 */
export function PairingScreen({
  role,
  qrUri,
  onScan,
  sas,
  onConfirm,
  onReject,
  embedded = false,
  busy,
  error,
  onRetry,
}: {
  role: 'host' | 'join';
  qrUri: string;
  onScan: () => void;
  sas: string;
  /**
   * A new pairing is pending until the user says the numbers match (design
   * button "They match"). Both controls show only with a SAS on screen.
   * Reject removes the pending pairing.
   */
  onConfirm?: () => void;
  onReject?: () => void;
  /**
   * Drop this screen's own appbar and scroll container, because a host is
   * already drawing both. Only the frame is suppressed. The content is the same.
   */
  embedded?: boolean;
  /** host: the QR is being made. join: the scanned code is being read. */
  busy?: 'making' | 'reading';
  /** The real message of the last failure. */
  error?: string;
  onRetry?: () => void;
}) {
  const shown = formatSas(sas);
  const spoken = /^\d{3} \d{3}$/.test(shown) ? shown.replace(/ /g, '').split('').join(' ') : shown;
  const body = (
    <>
      {role === 'host' ? (
        <View style={ui.stack}>
          <Text style={ui.h3}>Show this to the other device</Text>
          {busy === 'making' ? (
            <Busy label="Making your code…" />
          ) : error ? null : (
            <QrView uri={qrUri} label="Point their camera at this square." />
          )}
        </View>
      ) : (
        <View style={ui.stack}>
          <Text style={ui.h3}>Point the camera at their square</Text>
          {busy === 'reading' ? (
            <Busy label="Reading their code…" />
          ) : sas || error ? null : (
            <Text style={ui.hint}>Hold steady for a second.</Text>
          )}
          {/* Spec 3.3 Mode A is ONE QR and ONE scan. Only the joiner scans. A
              host never holds a joiner QR, so a host-side scan control would
              read a code that no device shows. */}
          <Btn label="Scan their code" onPress={onScan} testID="scan" block />
        </View>
      )}
      {sas ? (
        <View style={ui.card}>
          <Text style={ui.hint}>
            {role === 'host'
              ? 'Read this number out loud. Check it matches theirs.'
              : 'Their screen shows the same number. Check it matches yours.'}
          </Text>
          <Text style={ui.verify} accessibilityLabel={'Check number ' + spoken} testID="pairing-sas">
            {shown}
          </Text>
          {role === 'host' ? (
            <Accordion label="Why check the numbers" testID="pair-why">
              <Text style={ui.hint}>{`If both screens show ${shown}, only your two devices are in the room.`}</Text>
            </Accordion>
          ) : null}
        </View>
      ) : null}
      {sas && onConfirm ? (
        <Btn variant="primary" block testID="confirm" label="They match" onPress={onConfirm} />
      ) : null}
      {sas && onReject ? (
        <Btn variant="quiet" block testID="reject" label="Does not match" onPress={onReject} />
      ) : null}
      {error ? (
        <View style={ui.stackSm}>
          {/* The host reads no code. Its failure is "could not make the code".
              The design has only the joiner title, so the host title is an
              intentional deviation (see the ledger entries). */}
          <Note
            tone="err"
            title={role === 'host' ? "We couldn't make your code." : "We couldn't read that code."}
            body={
              role === 'host'
                ? `Make sure this device is on Wi-Fi, then try again. ${error}`
                : `Make sure their screen is showing the code, then try again. ${error}`
            }
            testID="pairing-error"
          />
          {onRetry ? <Btn variant="ghost" label="Try again" testID="pair-retry" onPress={onRetry} /> : null}
        </View>
      ) : null}
      {sas ? (
        <Text style={ui.hint}>
          That number is derived from both devices' keys. If it does not match, stop and pair again.
        </Text>
      ) : null}
      <Text style={ui.hint}>Both devices need to be on the same Wi-Fi.</Text>
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

