import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { PairingScreen, useEngine } from '@daak/ui';
import { armHostPairing, hostPairingQr, joinWithScan } from './pairing';
import { onPairingSas } from './bootstrap';

type Phase = { kind: 'choose' } | { kind: 'host'; qrUri: string } | { kind: 'join' };

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
export function PairingFlow() {
  const engine = useEngine();
  const [phase, setPhase] = useState<Phase>({ kind: 'choose' });
  const [sas, setSas] = useState('');
  const [error, setError] = useState('');

  useEffect(() => onPairingSas((received) => setSas(received)), []);

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
      <View>
        <Text>Pair with another Daak device</Text>
        <Pressable accessibilityLabel="host" onPress={startHost}>
          <Text>Show QR</Text>
        </Pressable>
        <Pressable accessibilityLabel="join" onPress={startJoin}>
          <Text>Scan</Text>
        </Pressable>
        {error ? <Text accessibilityLabel="pairing-error">{error}</Text> : null}
      </View>
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
        <Pressable accessibilityLabel="host-retry" onPress={startHost}>
          <Text>Show a new QR</Text>
        </Pressable>
      ) : null}
      <Pressable accessibilityLabel="confirm" onPress={acknowledge}>
        <Text>SAS matched - Done</Text>
      </Pressable>
      {error ? <Text accessibilityLabel="pairing-error">{error}</Text> : null}
    </View>
  );
}
