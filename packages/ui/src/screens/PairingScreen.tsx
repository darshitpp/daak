import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, type PressableStateCallbackType, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { CodePairingStatus } from '@daak/core';
import { QrView } from '../components/QrView';
import { Accordion } from '../components/Onboarding';
import { Btn, Note } from '../components/ds';
import { colors, control, radius, spacing, type, ui } from '../theme';
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
 * Milliseconds as the design clock reads them: `1:59`, `0:08`. The value
 * rounds up, so a code with a little time left reads `0:01` and not `0:00`.
 */
function clockText(ms: number): string {
  const secs = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

/** The six cells of the code field, in order. */
const CODE_CELLS = [0, 1, 2, 3, 4, 5];

/** The shapes the code panel adds. The rest comes from the theme. */
const s = StyleSheet.create({
  seg: {
    flexDirection: 'row',
    gap: spacing.xs,
    padding: spacing.xs,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
  },
  segItem: {
    flex: 1,
    minHeight: control.minHeight - 4,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
  },
  segOn: { backgroundColor: colors.fg },
  segLabelOn: { fontSize: type.sm, fontWeight: '600', color: colors.paper },
  segHover: { backgroundColor: colors.hover },
  segPressed: { opacity: 0.8 },
  segFocus: { borderWidth: 2, borderColor: colors.accent },
  code: { color: colors.accent },
  field: { position: 'relative' },
  fieldOff: { opacity: 0.45 },
  cells: { flexDirection: 'row', gap: spacing.sm, justifyContent: 'center' },
  cell: {
    width: 44,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.meta,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  cellOn: { borderColor: colors.fg },
  // The input covers the cells and holds the value, so one tap on the row
  // opens the keyboard. It draws no text of its own.
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    padding: 0,
    backgroundColor: 'transparent',
    color: 'transparent',
    // The macOS caret ignores caretHidden and the colour props. Zero opacity
    // hides the caret with the view. The view still takes taps and typing.
    opacity: 0,
  },
});

/**
 * The pairing panels (design routes `pair-first-device`, `pair-show-panel`,
 * `pair-scan-panel`, `pair-code-panel`, `pair-error`).
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
  onNewCode,
  codeSupported,
  codeMode,
  onCodeMode,
  code,
  codeStatus,
  codeBusy,
  codeDevices = [],
  codePick,
  onCodeSubmit,
  onCodeNew,
  onCodePick,
  onCodeBack,
  peerName,
  selfName,
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
  /**
   * Make a new code. The design puts this button under the number
   * (index.html:567). It does not revoke a pending pairing.
   */
  onNewCode?: () => void;
  /**
   * The flow runs code pairing. A build that cannot run it (a daemon client)
   * leaves this out or passes false, and the code panel stays hidden.
   */
  codeSupported?: boolean;
  /** `show` draws the host panel and `enter` the joiner panel. Absent = the QR panels. */
  codeMode?: 'show' | 'enter';
  /** A tab was tapped. The flow switches the mode. */
  onCodeMode?: (mode: 'show' | 'enter') => void;
  /** The host code, six digits. `482917` reads as `482 917`. */
  code?: string;
  /** The host poll. The panel reads the countdown from `remainingMs`. */
  codeStatus?: CodePairingStatus;
  /** The joiner call runs. Continue is disabled, so a second tap cannot burn a try. */
  codeBusy?: boolean;
  /** The unpaired peers. The flow filters the list and passes it ready to draw. */
  codeDevices?: { deviceId: string; name: string }[];
  /** The device the joiner picked. */
  codePick?: string;
  /** The joiner pressed Continue with six digits. */
  onCodeSubmit?: (code: string) => void;
  /** Make a new host code. */
  onCodeNew?: () => void;
  /** The joiner picked a device. */
  onCodePick?: (deviceId: string) => void;
  /** Go back to the pairing choices. */
  onCodeBack?: () => void;
  /** The peer name, shown at the check number. */
  peerName?: string;
  /**
   * This device's own name, for the host panel. The design names the device
   * that shows the code, so the other person reads the right screen.
   */
  selfName?: string;
}) {
  const shown = formatSas(sas);
  const spoken = /^\d{3} \d{3}$/.test(shown) ? shown.replace(/ /g, '').split('').join(' ') : shown;
  // The engine text is a DIAGNOSTIC, not user copy. It goes to the log.
  useEffect(() => {
    if (error !== undefined && error !== '') console.warn('daak: pairing failed:', error);
  }, [error]);
  // The joiner types the code here. The screen holds the typed digits, and the
  // flow reads them once, on Continue.
  const [digits, setDigits] = useState('');
  // The code panel is the third option. It needs a mode from the flow, and a
  // build that runs no code pairing leaves it hidden (spec Limits). The check
  // number replaces the code, so the panel goes with it: a code that is no
  // longer on screen must not be typed again, and the joiner's Continue goes
  // too, so a second tap cannot start a second pairing.
  const showCode = codeMode !== undefined && codeSupported !== false && !sas;
  // R3: the code dies on the deadline or on the last try. Either one is a dead
  // code, and the panel then shows the poll's reason.
  const dead = codeStatus?.state === 'expired' || codeStatus?.state === 'exhausted';
  // Two peers can advertise one name. The picker then adds a short id, so the
  // user picks the right device and does not burn a try on the wrong one.
  const picked = codePick !== undefined && codePick !== '';
  const nameCounts = new Map<string, number>();
  for (const d of codeDevices) nameCounts.set(d.name, (nameCounts.get(d.name) ?? 0) + 1);
  const codePanel = showCode ? (
    <View style={ui.stack} testID="pair-code-panel">
      {/* The two tabs are the only switch. The flow owns the mode and the tabs
          ask it to change. A tab is a full width tap target, so the whole chip
          answers a tap, a hover, and the focus ring of the platform. */}
      <View style={s.seg} testID="pair-code-seg" accessibilityRole="tablist">
        {(['show', 'enter'] as const).map((m) => {
          const label = m === 'show' ? 'Show the code' : 'Enter a code';
          const on = codeMode === m;
          return (
            <Pressable
              key={m}
              accessibilityRole="tab"
              accessibilityLabel={label}
              accessibilityState={{ selected: on }}
              testID={'pair-code-tab-' + m}
              onPress={() => {
                if (!on) onCodeMode?.(m);
              }}
              style={({ pressed, hovered, focused }: PressableStateCallbackType & { hovered?: boolean; focused?: boolean }) => [
                s.segItem,
                on ? s.segOn : hovered ? s.segHover : null,
                pressed ? s.segPressed : null,
                focused ? s.segFocus : null,
              ]}
            >
              <Text style={on ? s.segLabelOn : ui.chipLabel}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
      {codeMode === 'show' ? (
        dead ? (
          <View style={ui.stackSm}>
            <Note
              tone="err"
              testID="pair-code-dead"
              title={codeStatus?.state === 'exhausted' ? 'Too many tries.' : 'That code expired.'}
              body="Make a new one to keep going."
            />
            {onCodeNew ? (
              <Btn
                variant="ghost"
                size="sm"
                testID="pair-code-dead-new"
                label="Make a new pairing code"
                onPress={onCodeNew}
              />
            ) : null}
          </View>
        ) : (
          <View style={ui.stack}>
            <Text style={ui.h3}>Show this code to the other device</Text>
            {selfName ? <Text style={ui.hint}>{selfName}</Text> : null}
            <Text style={[ui.verify, s.code]} testID="pair-code-value">
              {formatSas(code ?? '')}
            </Text>
            <Text style={ui.hint}>This code works for 2 minutes.</Text>
            {codeStatus ? (
              <Text style={ui.hint} testID="pair-code-countdown">
                {`Waiting for the other device… ${clockText(codeStatus.remainingMs)}`}
              </Text>
            ) : null}
            {onCodeNew ? (
              <Btn
                variant="quiet"
                block
                testID="pair-code-new"
                label="Show a new pairing code"
                onPress={onCodeNew}
              />
            ) : null}
          </View>
        )
      ) : (
        <View style={ui.stack}>
          <Text style={ui.h3}>Enter the pairing code</Text>
          <Text style={ui.hint}>Pick the device that shows the code.</Text>
          {codeDevices.length === 0 ? (
            <Text style={ui.hint} testID="pair-code-none">
              No devices found. Check both devices are on the same Wi-Fi.
            </Text>
          ) : (
            codeDevices.map((d) => {
              const shortId = d.deviceId.slice(0, 8);
              const repeated = (nameCounts.get(d.name) ?? 0) > 1;
              return (
                <View key={d.deviceId} style={ui.stackSm}>
                  <Btn
                    variant={codePick === d.deviceId ? 'primary' : 'quiet'}
                    block
                    testID={'pair-code-pick-' + d.deviceId}
                    label={d.name}
                    // The short id is a second Text node on screen. A reader
                    // gets ONE element, so the button carries both strings.
                    accessibilityLabel={repeated ? `${d.name} ${shortId}` : undefined}
                    onPress={() => onCodePick?.(d.deviceId)}
                  />
                  {repeated ? (
                    <Text
                      style={ui.hint}
                      testID={'pair-code-id-' + d.deviceId}
                      accessibilityElementsHidden
                      importantForAccessibility="no-hide-descendants"
                    >
                      {shortId}
                    </Text>
                  ) : null}
                </View>
              );
            })
          )}
          {/* The device comes first. The code is for the device the user picked,
              so the field stays shut until a pick exists. */}
          <Text style={ui.hint} testID="pair-code-label">
            {picked ? 'Pairing code' : 'Pick a device first, then type its code.'}
          </Text>
          <View style={[s.field, picked ? null : s.fieldOff]}>
            {/* The cells show the digits and the input holds the value, so one
                tap on the row opens the keyboard. */}
            <View
              style={s.cells}
              testID="pair-code-cells"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              {CODE_CELLS.map((i) => (
                <View key={i} style={[s.cell, i === digits.length ? s.cellOn : null]} testID="pair-code-cell">
                  <Text style={ui.h2}>{digits[i] ?? ''}</Text>
                </View>
              ))}
            </View>
            <TextInput
              value={digits}
              onChangeText={(text) => setDigits(text.replace(/\D/g, '').slice(0, 6))}
              keyboardType="number-pad"
              maxLength={6}
              editable={picked}
              caretHidden
              cursorColor="transparent"
              selectionColor="transparent"
              // macOS only. The cells show the focus, so the system ring and
              // the caret would draw a second box over them.
              {...({ enableFocusRing: false } as object)}
              accessibilityLabel="Enter the six digit pairing code"
              testID="pair-code-input"
              style={s.overlay}
            />
          </View>
          <Btn
            variant="primary"
            block
            testID="pair-code-submit"
            label="Continue"
            disabled={!picked || digits.length < 6 || codeBusy === true}
            onPress={() => onCodeSubmit?.(digits)}
          />
          {codeBusy ? <Busy label="Checking the code…" /> : null}
          {/* The joiner learns one thing from a failure and nothing more. A
              wrong code, a dead code, and a network fault look the same. */}
          {error ? (
            <Note
              tone="err"
              testID="pair-code-error"
              title="That did not work."
              body="Check the six digits, and check the other device is still showing its code."
            />
          ) : null}
        </View>
      )}
      {onCodeBack ? (
        <Btn variant="ghost" block testID="pair-code-back" label="Choose another way" onPress={onCodeBack} />
      ) : null}
    </View>
  ) : null;
  const body = (
    <>
      {showCode ? (
        codePanel
      ) : (
        <>
          {role === 'host' ? (
            // A code-only host holds no QR. Draw nothing when there is no
            // square to show, so the check number is not followed by an empty
            // frame under the heading.
            qrUri !== '' || busy === 'making' || error !== undefined ? (
              <View style={ui.stack}>
                <Text style={ui.h3}>Show this to the other device</Text>
                {busy === 'making' ? (
                  <Busy label="Making your code…" />
                ) : error ? null : (
                  <QrView uri={qrUri} label="Point their camera at this square." />
                )}
              </View>
            ) : null
          ) : (
            <View style={ui.stack}>
              <Text style={ui.h3}>Point the camera at their square</Text>
              {busy === 'reading' ? (
                <Busy label="Reading their code…" />
              ) : sas || error ? null : (
                <>
                  {/* Design pair-scan-panel: the scan frame line, then the
                      hold-steady line. */}
                  <Text style={ui.hint}>Their square should fill the frame.</Text>
                  <Text style={ui.hint}>Hold steady for a second.</Text>
                </>
              )}
              {/* Spec 3.3 Mode A is ONE QR and ONE scan. Only the joiner scans. A
                  host never holds a joiner QR, so a host-side scan control would
                  read a code that no device shows. */}
              <Btn label="Scan their code" onPress={onScan} testID="scan" block />
            </View>
          )}
        </>
      )}
      {sas ? (
        <View style={ui.card}>
          {peerName ? <Text style={ui.hint}>{`Pairing with ${peerName}`}</Text> : null}
          <Text style={ui.hint}>
            {role === 'host'
              ? 'Read this number out loud. Check it matches theirs.'
              : 'Their screen shows the same number. Check it matches yours.'}
          </Text>
          <Text style={ui.verify} accessibilityLabel={'Check number ' + spoken} testID="pairing-sas">
            {shown}
          </Text>
          {role === 'host' ? (
            <>
              {/* Design index.html:567: a quiet, block button under the number. */}
              {onNewCode ? (
                <Btn variant="quiet" block testID="pair-newcode" label="Show a new code" onPress={onNewCode} />
              ) : null}
              <Accordion label="Why check the numbers" testID="pair-why">
                <Text style={ui.hint}>{`If both screens show ${shown}, only your two devices are in the room.`}</Text>
              </Accordion>
            </>
          ) : null}
        </View>
      ) : null}
      {sas && onConfirm ? (
        <Btn variant="primary" block testID="confirm" label="They match" onPress={onConfirm} />
      ) : null}
      {sas && onReject ? (
        <Btn variant="quiet" block testID="reject" label="Does not match" onPress={onReject} />
      ) : null}
      {error && !showCode ? (
        <View style={ui.stackSm}>
          {/* The host reads no code. Its failure is "could not make the code".
              The design has only the joiner title, so the host title is an
              intentional deviation (see the ledger entries). */}
          <Note
            tone="err"
            title={role === 'host' ? "We couldn't make your code." : "We couldn't read that code."}
            body={
              role === 'host'
                ? 'Make sure this device is on Wi-Fi, then try again.'
                : 'Make sure their screen is showing the code, then try again.'
            }
            testID="pairing-error"
          />
          {/* Not in the design. The apps keep no log, so without this line a
              release build hides why a pairing failed. */}
          <Text style={ui.hint} selectable testID="pairing-error-detail">
            {error}
          </Text>
          {onRetry ? <Btn variant="ghost" label="Try again" testID="pair-retry" onPress={onRetry} /> : null}
        </View>
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

