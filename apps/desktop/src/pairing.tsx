import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Btn, Note, PairingScreen, ui, useToast } from '@daak/ui';
import type { CodePairingStatus, DaakEngine } from '@daak/core/src/engine/types';
// Deep imports, NOT the @daak/platform barrel, for the reason index.js:14-22
// already records: that barrel re-exports every platform module, each of which
// runs TurboModuleRegistry.getEnforcing at module-eval time.
import { pairingBundle } from '@daak/platform/src/pairing';

type Phase =
  | { kind: 'idle' }
  | { kind: 'host'; qrUri: string; making: boolean }
  | { kind: 'code-host' }
  | { kind: 'code-join' };

/**
 * The desktop pairing flow.
 *
 * The QR flow is asymmetric: only the JOINER scans. The Mac shows a QR, the
 * phone scans it, and the host then arms its accept slot from that same
 * display. A Mac has no camera, so the QR path can only host.
 *
 * Code pairing closes that gap. The code host arm makes a six digit code and
 * arms the accept slot for one inbound pairing. The code joiner picks an
 * unpaired peer and types the code. A Mac can now do both sides.
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

  // Code pairing state. The flow owns each value. The screen draws them.
  const [code, setCode] = useState('');
  const [codeStatus, setCodeStatus] = useState<CodePairingStatus | undefined>(undefined);
  const [codeDevices, setCodeDevices] = useState<{ deviceId: string; name: string }[]>([]);
  const [codePick, setCodePick] = useState('');
  const [codeBusy, setCodeBusy] = useState(false);
  // This device's own name, for the host panel.
  const [selfName, setSelfName] = useState('');
  // A fresh code needs a fresh arm. The phase kind does not change for it.
  const [codeRound, setCodeRound] = useState(0);
  // The generation guard drops a slow poll that resolves after the panel closed.
  const codeGen = useRef(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // A double tap must call pair once. The screen disables Continue from this
  // flag, and the ref stops the tap that lands before the re-render.
  const codeBusyRef = useRef(false);
  // Set on unmount. A `pair` that is still running has no number on screen and
  // no peer in `pendingRef`, so its settle handler must revoke the pairing that
  // the engine commits after the unmount.
  const unmounted = useRef(false);

  const onEvent = useCallback(
    (event: { type: string; sas?: string; peerDeviceId?: string }) => {
      if (event.type === 'pairing.sas' && typeof event.sas === 'string') {
        setSas(event.sas);
        // The engine keeps the pairing pending. The id lets the user confirm or reject it.
        if (typeof event.peerDeviceId === 'string') {
          setPeerId(event.peerDeviceId);
          pendingRef.current = event.peerDeviceId;
        }
        // The code handshake finished. Stop the host poll and take the code off
        // the screen, so the number below is the one to compare.
        if (pollRef.current !== null) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
        codeGen.current += 1;
        setCode('');
        setCodeStatus(undefined);
        setCodeBusy(false);
        codeBusyRef.current = false;
      }
    },
    [],
  );
  useEffect(() => engine.on(onEvent), [engine, onEvent]);

  // Only an unmount of the pair route revokes. A re-render does not run this
  // cleanup, and the app going to the background does not unmount the route.
  // A remount reuses the ref, so the effect body resets the flag first.
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      const pending = pendingRef.current;
      pendingRef.current = '';
      if (pending) void engineRef.current.revokePairing(pending).catch(() => {});
    };
  }, []);

  // Run `engine.pair` and revoke the pairing when the route unmounts before the
  // call settles. The row does not exist until `pair` resolves, so the revoke
  // must wait for it.
  const pairOrRevoke = (peer: string, start: () => Promise<{ sas: string }>): Promise<{ sas: string }> => {
    const p = start();
    void p.then(
      () => {
        if (unmounted.current) {
          void engineRef.current.revokePairing(peer).catch(() => {});
        }
      },
      () => {},
    );
    return p;
  };

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

  // Resolution 2: one poll each second while the code-host panel is open. The
  // poll starts only AFTER the arm resolves with a code. An immediate poll can
  // read the PREVIOUS arm's state, and "Show a new pairing code" would then
  // flash the dead panel again for about a second.
  useEffect(() => {
    if (phase.kind !== 'code-host') return;
    const gen = ++codeGen.current;
    const stale = () => gen !== codeGen.current;
    setCode('');
    setCodeStatus(undefined);
    const poll = () => {
      void engineRef.current.codePairingStatus().then(
        (status) => {
          if (!stale()) setCodeStatus(status);
        },
        () => {},
      );
    };
    void engineRef.current.armCodePairing().then(
      (made) => {
        if (stale()) return;
        setCode(made);
        // The arm is in. Only now is the slot that the panel shows the live one.
        poll();
        pollRef.current = setInterval(poll, 1000);
      },
      (e: unknown) => {
        // A failed arm draws no code panel. The error note is the whole panel.
        if (!stale()) setError(e instanceof Error ? e.message : 'could not make a pairing code');
      },
    );
    // The host panel names this device. The name comes from the engine.
    void engineRef.current.selfProfile().then(
      (profile) => {
        if (!stale()) setSelfName(profile.name);
      },
      () => {},
    );
    return () => {
      codeGen.current += 1;
      if (pollRef.current !== null) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [phase.kind, codeRound]);

  // Resolution 3: leaving the code-host panel disarms the code. This effect is
  // keyed on the phase kind ALONE, so a codeRound change does not cancel. A
  // cancel that landed after a new arm would disarm the code on screen.
  useEffect(() => {
    if (phase.kind !== 'code-host') return;
    return () => {
      void engineRef.current.cancelCodePairing().catch(() => {});
    };
  }, [phase.kind]);

  // The picker removes the peers this device already trusts, so the rest is
  // ready to draw.
  useEffect(() => {
    if (phase.kind !== 'code-join') return;
    let alive = true;
    void engineRef.current.devices().then(
      (list) => {
        if (!alive) return;
        setCodeDevices(
          list.filter((d) => d.paired !== true).map((d) => ({ deviceId: d.deviceId, name: d.name })),
        );
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [phase.kind]);

  // The third choice: the code host. This device shows a code.
  const startCodeHost = () => {
    setSas('');
    setPeerId('');
    setError('');
    setConfirmError('');
    setCode('');
    setCodeStatus(undefined);
    setCodePick('');
    setPhase({ kind: 'code-host' });
  };

  // The fourth choice: join by code. This device types the code.
  const startCodeJoin = () => {
    setSas('');
    setPeerId('');
    setError('');
    setConfirmError('');
    setCodePick('');
    setCodeDevices([]);
    setPhase({ kind: 'code-join' });
  };

  // The tabs of the code panel change the code mode, so both halves are reachable.
  const switchCodeMode = (mode: 'show' | 'enter') => {
    setSas('');
    setPeerId('');
    setError('');
    setCodePick('');
    setPhase({ kind: mode === 'enter' ? 'code-join' : 'code-host' });
  };

  // The code is dead, or the user asked for a new one. The round bump arms a
  // fresh code: the phase kind does not change.
  const newCodeHost = () => {
    setSas('');
    setPeerId('');
    setError('');
    setCode('');
    setCodeStatus(undefined);
    setCodeRound((n) => n + 1);
    setPhase({ kind: 'code-host' });
  };

  // Back to the choices. The code-host effect cleanup disarms the code.
  const leaveCode = () => {
    setSas('');
    setPeerId('');
    setError('');
    setConfirmError('');
    setCode('');
    setCodeStatus(undefined);
    setCodePick('');
    setCodeDevices([]);
    setPhase({ kind: 'idle' });
  };

  // The joiner typed six digits and pressed Continue. The screen disables
  // Continue while `codeBusy` is true, so a double tap calls the engine once.
  const submitCode = (digits: string) => {
    const deviceId = codePick;
    if (codeBusyRef.current) return;
    if (!deviceId) {
      setError('pick the device that shows the code first');
      return;
    }
    codeBusyRef.current = true;
    setCodeBusy(true);
    setError('');
    void pairOrRevoke(deviceId, () => engine.pair(deviceId, 'code', digits)).then(
      ({ sas: received }) => {
        codeBusyRef.current = false;
        setCodeBusy(false);
        // Unmounted mid-pair: `pairOrRevoke` already revoked. Do not resurrect
        // the number on a dead route.
        if (unmounted.current) return;
        setSas(received);
        setPeerId(deviceId);
        pendingRef.current = deviceId;
      },
      (e: unknown) => {
        codeBusyRef.current = false;
        setCodeBusy(false);
        setError(e instanceof Error ? e.message : 'that pairing did not work');
      },
    );
  };

  const hosting = phase.kind === 'host' || phase.kind === 'code-host';
  const codePhase = phase.kind === 'code-host' || phase.kind === 'code-join';

  if (phase.kind === 'idle') {
    return (
      <View style={{ padding: 16, gap: 24 }}>
        <View style={ui.stack}>
          <Text style={ui.lead}>Open Daak on the other device and choose Scan a code. This Mac shows the code.</Text>
          <Btn variant="primary" block testID="host" label="Show my code" onPress={showQr} />
          {/* The code choices draw only on a build that can run code pairing. */}
          {engine.codePairingSupported ? (
            <>
              <Btn variant="quiet" block testID="code-host" label="Use a pairing code" onPress={startCodeHost} />
              <Btn variant="quiet" block testID="code-join" label="Join a device" onPress={startCodeJoin} />
            </>
          ) : null}
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
        role={hosting ? 'host' : 'join'}
        qrUri={phase.kind === 'host' ? phase.qrUri : ''}
        onScan={showQr}
        sas={sas}
        onConfirm={peerId ? confirm : undefined}
        onReject={peerId ? reject : undefined}
        busy={phase.kind === 'host' && phase.making ? 'making' : undefined}
        error={error || undefined}
        onRetry={showQr}
        // The design puts "Show a new code" under the number.
        onNewCode={sas ? (phase.kind === 'code-host' ? newCodeHost : showQr) : undefined}
        // Code pairing. The flow owns each value; the screen only draws them.
        codeSupported={engine.codePairingSupported}
        // No code panel until the arm answers with a code. A failed arm draws
        // only the error note.
        codeMode={
          phase.kind === 'code-host' && code !== ''
            ? 'show'
            : phase.kind === 'code-join'
              ? 'enter'
              : undefined
        }
        onCodeMode={switchCodeMode}
        code={phase.kind === 'code-host' ? code : undefined}
        codeStatus={phase.kind === 'code-host' ? codeStatus : undefined}
        codeBusy={phase.kind === 'code-join' ? codeBusy : undefined}
        codeDevices={phase.kind === 'code-join' ? codeDevices : []}
        codePick={phase.kind === 'code-join' && codePick ? codePick : undefined}
        selfName={phase.kind === 'code-host' ? selfName : undefined}
        onCodeSubmit={phase.kind === 'code-join' ? submitCode : undefined}
        onCodeNew={phase.kind === 'code-host' && (code !== '' || codeStatus !== undefined) ? newCodeHost : undefined}
        onCodePick={phase.kind === 'code-join' ? setCodePick : undefined}
        // The check number is answered with They match or Does not match, so the
        // way back hides there. A back press would leave a pending pairing that
        // nobody answered.
        onCodeBack={codePhase && !sas ? leaveCode : undefined}
        // The joiner picked this device, so it knows the name at the check number.
        peerName={
          phase.kind === 'code-join' ? codeDevices.find((d) => d.deviceId === codePick)?.name : undefined
        }
      />
      {/* The arm is one-shot. One button arms again. It shows only before a SAS,
          because the screen then draws the design button under the number. */}
      <View style={{ padding: 16, gap: 24 }}>
        {phase.kind === 'host' && !sas ? (
          <Btn variant="quiet" block testID="host-retry" label="Show a new code" onPress={showQr} />
        ) : null}
        {/* The host arm has no note of its own, so the flow shows it here. */}
        {phase.kind === 'code-host' && error ? (
          <Note tone="err" title="We couldn't make your code." body={error} testID="pair-code-host-error" />
        ) : null}
        {confirmError ? (
          <Note tone="err" title="We couldn't finish pairing." body={confirmError} testID="pairing-confirm-error" />
        ) : null}
      </View>
    </View>
  );
}
