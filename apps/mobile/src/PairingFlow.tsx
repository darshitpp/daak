import React, { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Btn, Note, PairingScreen, Section, useEngine } from '@daak/ui';
import { armHostPairing, hostPairingQr, joinWithScan, parsePairingPayload } from './pairing';
import { onPairingSas } from './bootstrap';

type Phase = { kind: 'choose' } | { kind: 'host'; qrUri: string } | { kind: 'join' };

// The shared scroll-content padding, restated here because packages/ui keeps
// `ui.pad` internal to its screens; padding is a token, not a design system.
const pad = { padding: 16, gap: 24 } as const;

/**
 * The stateful half of QR pairing (R100): it lives in the APP, feeds the
 * presentational PairingScreen, and reaches the native scanner through the
 * @daak/platform facades -- packages/ui stays pure-presentational.
 *
 * R98: lazy. Nothing here fetches a pairing bundle or renders a QR until the
 * user enters the host flow; the entry point is the pair tab App.tsx wires
 * into AppShell.
 *
 * R99: the engine comes from the EngineProvider App.tsx built ONCE in
 * bootstrap. Nothing here constructs a second engine and nothing here opens a
 * second engine.on: the host half of the SAS arrives via onPairingSas, which
 * is a fan-out from the ONE subscription inside bootstrap.startEngine
 * (R42/R91). The joiner's SAS comes back synchronously from engine.pair.
 */
export function PairingFlow({ bundle }: { bundle?: string } = {}) {
  const engine = useEngine();
  const [phase, setPhase] = useState<Phase>({ kind: 'choose' });
  const [sas, setSas] = useState('');
  const [error, setError] = useState('');

  useEffect(() => onPairingSas((received) => setSas(received)), []);

  // A link bundle IS a join, with no camera: the user already chose to pair by
  // opening the link, and a scanner prompt on top of that is a step that does
  // not exist in the flow. Joined on bundle IDENTITY, not on mount: this
  // component is mounted whenever the pair route opens, so a plain mount effect
  // would re-pair a user who came here from Devices.
  useEffect(() => {
    if (!bundle) return;
    setSas('');
    setError('');
    setPhase({ kind: 'join' });
    void Promise.resolve()
      .then(() => {
        const { deviceId, cbor } = parsePairingPayload(bundle);
        return engine.pair(deviceId, 'qr', cbor);
      })
      .then(
        ({ sas: received }) => setSas(received),
        (e: unknown) => setError(e instanceof Error ? e.message : 'that pairing link did not work'),
      );
  }, [bundle, engine]);

  const startHost = () => {
    setSas('');
    setError('');
    // Lazy (R98): the bundle is fetched and rendered only when the user enters
    // the host flow, never at app start.
    //
    // C2, second review: spec 3.3 Mode A is ONE QR and ONE scan. The host
    // shows its QR; the JOINER scans it. The host then arms its accept slot
    // from that same display -- no camera, and no scanned bundle, because only
    // the joiner ever holds a bundle and the sanctioned flow never gives the
    // host the joiner's. The two previous passes each got this wrong in a
    // different direction (arm-then-QR, then QR-then-mutual-scan); this is the
    // shape the spec describes.
    //
    // Arming here rather than on a second tap is deliberate: the host has
    // nothing else to do, and an arm that needs a button is an arm a user can
    // leave unarmed while a joiner waits. A joiner that connects before the QR
    // is fetched is refused as unpaired and retries, which is the same window
    // every engine-side arm has.
    void hostPairingQr().then(
      ({ uri }) => {
        setPhase({ kind: 'host', qrUri: uri });
        return armHostPairing(engine);
      },
      () => setError('hosting failed'),
    ).catch((e: unknown) =>
      setError(e instanceof Error ? e.message : 'arming failed'),
    );
  };

  const startJoin = () => {
    setSas('');
    setError('');
    setPhase({ kind: 'join' });
    void joinWithScan(engine).then(
      ({ sas: received }) => setSas(received),
      (e: unknown) => setError(e instanceof Error ? e.message : 'scan failed'),
    );
  };

  // Not a gate. The engine persists the pairing row BEFORE either SAS is
  // shown (Engine::commit_pairing), so there is nothing here to approve -- the
  // button only acknowledges that the two SAS matched and returns to the
  // start. A confirm API that actually gated the commit is a Phase 7 change
  // with a crypto consequence; see the blocker report.
  const acknowledge = () => {
    setSas('');
    setError('');
    setPhase({ kind: 'choose' });
  };

  if (phase.kind === 'choose') {
    return (
      <ScrollView contentContainerStyle={pad}>
        <Section title="Pair with another Daak device">
          <Btn variant="primary" block testID="host" label="Show QR" onPress={startHost} />
          <Btn variant="quiet" block testID="join" label="Scan" onPress={startJoin} />
          {error ? <Note tone="err" testID="pairing-error" body={error} /> : null}
          <Note
            title="Nothing here leaves the network"
            body="Pairing shows a code and reads one back. No account, no server."
          />
        </Section>
      </ScrollView>
    );
  }
  return (
    <View>
      <PairingScreen
        role={phase.kind}
        qrUri={phase.kind === 'host' ? phase.qrUri : ''}
        onScan={startJoin}
        sas={sas}
      />
      {/* The arm is ONE-SHOT: the engine takes it for the first joiner, and a
          stray LAN connection can fail a pairing without consuming the user
          back to this screen. `startHost` already re-arms (the engine arm slot
          is REPLACEABLE), so recovery is this one button and no new plumbing.
          Rendered in the host phase unconditionally -- including before any
          SAS has arrived, which is the state a burnt arm leaves behind. */}
      {phase.kind === 'host' ? (
        <View style={pad}>
          <Btn variant="quiet" block testID="host-retry" label="Show a new QR" onPress={startHost} />
        </View>
      ) : null}
      <View style={pad}>
        <Btn variant="primary" block testID="confirm" label="SAS matched - Done" onPress={acknowledge} />
        {error ? <Note tone="err" testID="pairing-error" body={error} /> : null}
      </View>
    </View>
  );
}
