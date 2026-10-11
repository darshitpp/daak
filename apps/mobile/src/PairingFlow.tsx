import React, { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Btn, Note, PairingScreen, Section, ToastProvider, ui, useEngine, useToast } from '@daak/ui';
import { armHostPairing, hostPairingQr, joinWithScan, parsePairingPayload } from './pairing';
import { onPairingSas } from './bootstrap';

type Phase = { kind: 'choose' } | { kind: 'host'; qrUri: string } | { kind: 'join' };
type Busy = 'making' | 'reading' | null;

// The shared scroll-content padding. `packages/ui` keeps `ui.pad` internal to its
// screens, and padding is a token and not a design system.
const pad = { padding: 16, gap: 24 } as const;

/**
 * The stateful half of QR pairing (R100). It lives in the app, feeds the
 * presentational `PairingScreen`, and reaches the native scanner through the
 * `@daak/platform` facades.
 *
 * R98: lazy. Nothing here fetches a pairing bundle or draws a QR until the user
 * enters the host flow.
 *
 * R99: the engine comes from the `EngineProvider` that App.tsx built once.
 * Nothing here builds a second engine or opens a second `engine.on`. The host
 * half of the SAS arrives through `onPairingSas`, a fan-out from the one
 * subscription in `bootstrap.startEngine`. The joiner SAS comes back from
 * `engine.pair`.
 *
 * The engine keeps a new pairing pending until `confirmPairing`. "They match"
 * confirms it. "Does not match" revokes it. Both need the peer id: the host
 * reads it from the SAS event and the joiner reads it from the scan or the link.
 *
 * Leaving the route is "Does not match". `pendingRef` holds the peer id of a
 * number that is on screen and that the user has not answered. The unmount
 * cleanup revokes that pairing, so it does not linger until a restart. If the
 * route unmounts while `engine.pair` is still running, no number is on screen
 * yet, so the settle handler revokes the pairing after the engine commits it.
 *
 * "Pairing cancelled" is the shared toast. The first-run flow renders instead of
 * the shell, so `PairingFlow` adds its own provider when it is embedded.
 */
type PairingFlowProps = { bundle?: string; addr?: string; embedded?: boolean };

export function PairingFlow(props: PairingFlowProps = {}) {
  const body = <PairingFlowBody {...props} />;
  // The phone design shows the toast as a full-width bar.
  return props.embedded ? <ToastProvider layout="bar">{body}</ToastProvider> : body;
}

function PairingFlowBody({ bundle, addr, embedded = false }: PairingFlowProps) {
  const engine = useEngine();
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>({ kind: 'choose' });
  const [sas, setSas] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<Busy>(null);
  // A failed confirm has its own message and title. `error` belongs to the
  // host and join steps, whose title says "make" or "read" a code.
  const [confirmError, setConfirmError] = useState('');
  // The peer id of a number that is on screen and not yet answered. A ref, so
  // the unmount cleanup reads the latest value without a stale closure.
  const pendingRef = useRef('');
  // Set in the unmount cleanup. A `pair` that is still running has no SAS on
  // screen and no peer in `pendingRef`, so its settle handler must check this
  // flag to revoke the pairing the engine commits after the unmount (3.9).
  const unmounted = useRef(false);
  const engineRef = useRef(engine);
  engineRef.current = engine;
  // Only an unmount of the pair route revokes. A re-render does not run this
  // cleanup, and the app going to the background does not unmount the route.
  // A remount reuses the ref, so the effect body must reset the flag. Without
  // the reset a remount is treated as an unmount and the join revokes the
  // pairing it just committed (Fast Refresh).
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      const id = pendingRef.current;
      pendingRef.current = '';
      if (id) void engineRef.current.revokePairing(id).catch(() => {});
    };
  }, []);

  // 3.9: run `engine.pair` and, when the route unmounts before `pair` settles,
  // revoke the pairing the engine commits. The row does NOT exist until `pair`
  // resolves, so the revoke must wait for it: a revoke at unmount time would be
  // a no-op. The unmount cleanup covers the SAS-on-screen window instead.
  const pairOrRevoke = (
    peer: string,
    start: () => Promise<{ sas: string }>,
  ): Promise<{ sas: string }> => {
    const p = start();
    void p.then(
      () => {
        if (unmounted.current) {
          pendingRef.current = '';
          void engineRef.current.revokePairing(peer).catch(() => {});
        }
      },
      () => {},
    );
    return p;
  };

  // The peer the SAS belongs to. The engine keeps a new pairing pending until
  // confirmPairing, so the screen needs the id to confirm or reject it.
  const [peerId, setPeerId] = useState('');

  useEffect(
    () =>
      onPairingSas((received, peer) => {
        setSas(received);
        setPeerId(peer);
        pendingRef.current = peer;
        setBusy(null);
      }),
    [],
  );

  // A link bundle is a join with no camera. But a link is a request from
  // another app or a web page, so it never joins by itself: the user sees who
  // is asking and taps Pair.
  const [link, setLink] = useState<{ parsed: ReturnType<typeof parsePairingPayload>; name: string } | null>(
    null,
  );

  useEffect(() => {
    setLink(null);
    if (!bundle) return;
    setSas('');
    pendingRef.current = '';
    setError('');
    setConfirmError('');
    try {
      const parsed = parsePairingPayload(bundle);
      const raw = (JSON.parse(bundle) as { name?: unknown }).name;
      const name = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 64) : 'another device';
      setLink({ parsed, name });
    } catch (e) {
      setPhase({ kind: 'join' });
      setError(e instanceof Error ? e.message : 'that pairing link did not work');
    }
  }, [bundle, addr]);

  const joinLink = () => {
    if (!link) return;
    const { parsed } = link;
    setLink(null);
    setPhase({ kind: 'join' });
    setBusy('reading');
    // `addr` comes from the link first and the bundle second. Both name the
    // same host and either can be absent.
    void pairOrRevoke(parsed.deviceId, () =>
      engine.pair(parsed.deviceId, 'qr', parsed.cbor, addr ?? parsed.addr),
    ).then(
      ({ sas: received }) => {
        // Unmounted mid-pair: `pairOrRevoke` already revoked. Do not resurrect
        // the SAS on a dead route.
        if (unmounted.current) return;
        setSas(received);
        setPeerId(parsed.deviceId);
        pendingRef.current = parsed.deviceId;
        setBusy(null);
      },
      (e: unknown) => {
        setBusy(null);
        setError(e instanceof Error ? e.message : 'that pairing link did not work');
      },
    );
  };

  const startHost = () => {
    setSas('');
    setPeerId('');
    pendingRef.current = '';
    setError('');
    setConfirmError('');
    // The host phase starts at once, so "Making your code…" shows while the
    // bundle and the QR are made. Spec 3.3 Mode A is one QR and one scan.
    setPhase({ kind: 'host', qrUri: '' });
    setBusy('making');
    void hostPairingQr()
      .then(
        ({ uri }) => {
          setPhase({ kind: 'host', qrUri: uri });
          setBusy(null);
          return armHostPairing(engine);
        },
        // The real message. A fixed string hides the cause.
        (e: unknown) => {
          setBusy(null);
          setError(e instanceof Error ? e.message : 'hosting failed');
        },
      )
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'arming failed'));
  };

  const startJoin = () => {
    setSas('');
    setPeerId('');
    pendingRef.current = '';
    setError('');
    setConfirmError('');
    setPhase({ kind: 'join' });
    setBusy(null);
    // 3.9: the scan and the engine call both run before any SAS is on screen,
    // so `pendingRef` is empty. When this settles after an unmount, revoke the
    // pairing the engine just committed -- an unmount-time revoke would be a
    // no-op, because the row does not exist until `pair` resolves.
    void joinWithScan(engine, () => setBusy('reading')).then(
      ({ sas: received, peerDeviceId }) => {
        if (unmounted.current) {
          pendingRef.current = '';
          void engineRef.current.revokePairing(peerDeviceId).catch(() => {});
          return;
        }
        setSas(received);
        setPeerId(peerDeviceId);
        pendingRef.current = peerDeviceId;
        setBusy(null);
      },
      (e: unknown) => {
        setBusy(null);
        setError(e instanceof Error ? e.message : 'scan failed');
      },
    );
  };

  // The engine keeps a new pairing pending: it grants nothing until the user
  // says the two numbers matched. Reject removes the pending pairing.
  const reject = () => {
    const id = peerId;
    // The press answers the number. The unmount cleanup must not revoke again.
    pendingRef.current = '';
    setSas('');
    setPeerId('');
    setPhase({ kind: 'choose' });
    setError('');
    setConfirmError('');
    setBusy(null);
    toast.show('Pairing cancelled');
    if (id) {
      void engine
        .revokePairing(id)
        .catch((e: unknown) => setError(e instanceof Error ? e.message : 'could not remove the pairing'));
    }
  };

  // "They match". The engine trusts the peer and emits `pairing.done`.
  const confirm = () => {
    const id = peerId;
    setConfirmError('');
    // The press answers the number. A failed confirm leaves the pairing pending,
    // so the failure arm puts the id back for the unmount cleanup.
    pendingRef.current = '';
    void engine.confirmPairing(id).then(
      () => {
        setSas('');
        setPeerId('');
        setBusy(null);
        setPhase({ kind: 'choose' });
      },
      (e: unknown) => {
        pendingRef.current = id;
        setConfirmError(e instanceof Error ? e.message : 'could not confirm the pairing');
      },
    );
  };

  if (link) {
    return (
      <View style={embedded ? ui.stack : undefined}>
        <Section title={`Pair with ${link.name}?`}>
          <Note
            tone="warn"
            body="A link asked to pair this device. Pair only if you opened this link yourself and know this device."
          />
          <Btn variant="primary" block testID="link-pair-confirm" label="Pair" onPress={joinLink} />
          <Btn variant="quiet" block testID="link-pair-cancel" label="Cancel" onPress={() => setLink(null)} />
        </Section>
      </View>
    );
  }
  if (phase.kind === 'choose') {
    return (
      <View style={embedded ? ui.stack : undefined}>
        <View style={ui.stack}>
          <Text style={ui.lead}>Open Daak on the other device, then pick how you want to join up.</Text>
          <Btn variant="primary" block testID="host" label="Show my code" onPress={startHost} />
          <Btn variant="quiet" block testID="join" label="Scan a code" onPress={startJoin} />
          {/* `reject` returns to this pane and then removes the pairing. A failed
              removal sets `error`. Without this note the failure would be silent. */}
          {error ? <Note tone="err" title="We couldn't remove that pairing." body={error} testID="pairing-error" /> : null}
        </View>
      </View>
    );
  }
  return (
    // flex: 1 is needed. The root of `PairingScreen` is `ui.screen` (flex: 1).
    <View style={embedded ? undefined : ui.screen} testID="pair-frame">
      <PairingScreen
        role={phase.kind}
        qrUri={phase.kind === 'host' ? phase.qrUri : ''}
        onScan={startJoin}
        sas={sas}
        onConfirm={peerId ? confirm : undefined}
        onReject={peerId ? reject : undefined}
        embedded={embedded}
        busy={busy ?? undefined}
        error={error || undefined}
        onRetry={phase.kind === 'host' ? startHost : startJoin}
        // The design puts "Show a new code" under the number. The screen draws
        // it once a SAS is on it.
        onNewCode={phase.kind === 'host' && sas ? startHost : undefined}
      />
      {/* The arm is one-shot. `startHost` arms again. Before a SAS arrives the
          screen shows no button of its own, so this one is the only recovery
          from a burnt arm. It goes once the screen draws its own button. */}
      {phase.kind === 'host' && !sas ? (
        <View style={pad}>
          <Btn variant="quiet" block testID="host-retry" label="Show a new code" onPress={startHost} />
        </View>
      ) : null}
      {confirmError ? (
        <View style={pad}>
          <Note tone="err" title="We couldn't finish pairing." body={confirmError} testID="pairing-confirm-error" />
        </View>
      ) : null}
    </View>
  );
}

