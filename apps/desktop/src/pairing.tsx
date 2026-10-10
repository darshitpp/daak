import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Btn, Note, PairingScreen, ui, useToast } from '@daak/ui';
import type { DaakEngine } from '@daak/core/src/engine/types';
// Deep imports, NOT the @daak/platform barrel, for the reason index.js:14-22
// already records: that barrel re-exports every platform module, each of which
// runs TurboModuleRegistry.getEnforcing at module-eval time.
import { pairingBundle } from '@daak/platform/src/pairing';

type Phase = { kind: 'idle' } | { kind: 'host'; qrUri: string; making: boolean };

/**
 * The desktop HOST half of pairing, and only that half.
 *
 * The QR flow is asymmetric: only the JOINER scans. The Mac shows a code, the
 * phone scans it, and the host then arms its accept slot from that same display
 * -- no camera, and no scanned bundle.
 *
 * The SAS subscription is OWNED HERE, not in a second engine.on above: this
 * component mounts only while the pair route is open and unsubscribes on
 * unmount, so the subscription exists exactly when something reads it.
 *
 * The engine keeps a new pairing pending until `confirmPairing`. The
 * `pairing.sas` event names the peer, so "They match" can confirm it and
 * "Does not match" can revoke it.
 *
 * Leaving the route is "Does not match". `pendingRef` holds the peer id of a
 * number that is on screen and that the user has not answered.
 */
export function DesktopPairing({ engine }: { engine: DaakEngine }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [sas, setSas] = useState('');
  const [peerId, setPeerId] = useState('');
  const [error, setError] = useState('');
  // A failed confirm has its own title. `error` is for the code-making steps.
  const [confirmError, setConfirmError] = useState('');
  const toast = useToast();
  // The peer id of a number that is on screen and not yet answered.
  const pendingRef = useRef('');
  const engineRef = useRef(engine);
  engineRef.current = engine;

  const onEvent = useCallback(
    (event: { type: string; sas?: string; peerDeviceId?: string }) => {
      if (event.type === 'pairing.sas' && typeof event.sas === 'string') {
        setSas(event.sas);
        // The engine keeps the pairing pending. The id lets the user confirm or reject it.
        if (typeof event.peerDeviceId === 'string') {
          setPeerId(event.peerDeviceId);
          pendingRef.current = event.peerDeviceId;
        }
      }
    },
    [],
  );
  useEffect(() => engine.on(onEvent), [engine, onEvent]);

  // Only an unmount of the pair route revokes. A re-render does not run this
  // cleanup, and the app going to the background does not unmount the route.
  useEffect(
    () => () => {
      const pending = pendingRef.current;
      pendingRef.current = '';
      if (pending) void engineRef.current.revokePairing(pending).catch(() => {});
    },
    [],
  );

  // "They match". The engine trusts the peer and emits `pairing.done`.
  const confirm = () => {
    const id = peerId;
    setConfirmError('');
    // The press answers the number. A failed confirm puts the id back below.
    pendingRef.current = '';
    void engine.confirmPairing(id).then(
      () => {
        setSas('');
        setPeerId('');
        setPhase({ kind: 'idle' });
      },
      (e: unknown) => {
        pendingRef.current = id;
        setConfirmError(e instanceof Error ? e.message : 'could not confirm the pairing');
      },
    );
  };

  // The numbers did not match: remove the pending pairing.
  const reject = () => {
    const id = peerId;
    // The press answers the number. The unmount cleanup must not revoke again.
    pendingRef.current = '';
    setSas('');
    setPeerId('');
    setPhase({ kind: 'idle' });
    setError('');
    setConfirmError('');
    toast.show('Pairing cancelled');
    if (id) {
      void engine.revokePairing(id).catch((e: unknown) =>
        setError(e instanceof Error ? e.message : 'could not remove the pairing'),
      );
    }
  };

  const showQr = () => {
    setSas('');
    setPeerId('');
    pendingRef.current = '';
    setError('');
    setConfirmError('');
    // The qr module loads lazily. `js/NativeDaakQrScanner.ts` calls
    // `TurboModuleRegistry.getEnforcing` at module eval, so a top-level import
    // fails the whole app when the pod is not linked.
    const qr = require('@daak/platform/src/qr') as typeof import('@daak/platform/src/qr');
    // The host phase starts at once, so "Making your code…" shows.
    setPhase({ kind: 'host', qrUri: '', making: true });
    void pairingBundle()
      .then((bundle) => qr.generateQr(bundle, qr.PAIRING_QR_SIZE))
      .then(
        async (qrUri) => {
          setPhase({ kind: 'host', qrUri, making: false });
          await engine.armHostPairing();
        },
        (e: unknown) => {
          setPhase({ kind: 'idle' });
          setError(e instanceof Error ? e.message : 'could not make a pairing code');
        },
      )
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'could not arm pairing'));
  };

  if (phase.kind === 'idle') {
    return (
      <View style={{ padding: 16, gap: 24 }}>
        <View style={ui.stack}>
          <Text style={ui.lead}>Open Daak on the other device and choose Scan a code. This Mac shows the code.</Text>
          <Btn variant="primary" block testID="host" label="Show my code" onPress={showQr} />
          {error ? <Note tone="err" body={error} testID="pairing-error" /> : null}
          <Text style={ui.hint}>Both devices need to be on the same Wi-Fi.</Text>
        </View>
      </View>
    );
  }

  return (
    // flex: 1 is load-bearing. PairingScreen's own root IS ui.screen (flex: 1).
    <View style={{ flex: 1 }}>
      <PairingScreen
        role="host"
        qrUri={phase.qrUri}
        onScan={showQr}
        sas={sas}
        onConfirm={peerId ? confirm : undefined}
        onReject={peerId ? reject : undefined}
        busy={phase.making ? 'making' : undefined}
        error={error || undefined}
        onRetry={showQr}
      />
      {/* The arm is one-shot. One button arms again. */}
      <View style={{ padding: 16, gap: 24 }}>
        <Btn variant="quiet" block testID="host-retry" label="Show a new code" onPress={showQr} />
        {confirmError ? (
          <Note tone="err" title="We couldn't finish pairing." body={confirmError} testID="pairing-confirm-error" />
        ) : null}
      </View>
    </View>
  );
}

