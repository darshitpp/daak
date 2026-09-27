import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { PairingScreen, useEngine } from '@daak/ui';
import { hostPairingQr, joinWithScan } from './pairing';
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
    void hostPairingQr().then(
      ({ uri }) => setPhase({ kind: 'host', qrUri: uri }),
      () => setError('hosting failed'),
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

  const confirm = () => {
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
      <Pressable accessibilityLabel="confirm" onPress={confirm}>
        <Text>Confirm</Text>
      </Pressable>
      {error ? <Text accessibilityLabel="pairing-error">{error}</Text> : null}
    </View>
  );
}
