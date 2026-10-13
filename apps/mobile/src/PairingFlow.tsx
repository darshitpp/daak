import React, { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Btn, Note, PairingScreen, Section, ToastProvider, ui, useEngine, useToast } from '@daak/ui';
import type { CodePairingStatus } from '@daak/core';
import {
  armHostPairing,
  hostPairingQr,
  hostShowCode,
  joinWithCode,
  joinWithScan,
  parsePairingPayload,
} from './pairing';
import { onPairingSas } from './bootstrap';

type Phase =
  | { kind: 'choose' }
  | { kind: 'host'; qrUri: string }
  | { kind: 'join' }
  | { kind: 'code-host' }
  | { kind: 'code-join' };
type Busy = 'making' | 'reading' | null;

// The shared scroll-content padding. `packages/ui` keeps `ui.pad` internal to its
// screens, and padding is a token and not a design system.
const pad = { padding: 16, gap: 24 } as const;

/**
 * The stateful half of QR pairing (R100). It lives in the app, feeds the
 * presentational `PairingScreen`, and reaches the native scanner through the
 * `@daak/platform` facades.
 *
 * Code pairing is the second option. The host arms a six digit code and polls
 * the engine for its state, because the engine is the only clock. The joiner
 * picks an unpaired peer and types the code. The flow owns the mode, the poll,
 * the busy flag, and the cancel on exit.
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
  // Code pairing. The flow owns the mode, the poll, and the busy flag. The
  // screen draws the panel and reads these values from props.
  const [code, setCode] = useState('');
  const [codeStatus, setCodeStatus] = useState<CodePairingStatus | undefined>(undefined);
  const [codeDevices, setCodeDevices] = useState<{ deviceId: string; name: string }[]>([]);
  const [codePick, setCodePick] = useState('');
  const [codeBusy, setCodeBusy] = useState(false);
  // This device's own name, for the host panel.
  const [selfName, setSelfName] = useState('');
  // A fresh code needs a fresh arm, and the phase kind does not change for it.
  const [codeRound, setCodeRound] = useState(0);
  // Resolution 2: the generation ref drops a slow poll that resolves after the
  // generation ended, and the interval ref lets the SAS handler stop the poll.
  const codeGen = useRef(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // A double tap must call pair once. The screen disables Continue from this
  // flag, and the ref stops the tap that lands before the re-render.
  const codeBusyRef = useRef(false);
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
        // Resolution 1: the code handshake finished. Stop the host poll and
        // take the code off the screen, so the SAS step below is the number to
        // compare. The QR flows share this handler and set no code.
        if (pollRef.current !== null) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
        codeGen.current += 1;
        setCode('');
        setCodeStatus(undefined);
      }),
    [],
  );

  // Resolution 2: one poll each second while the code-host panel is open. The
  // poll starts only AFTER the arm resolves with a code. An immediate poll can
  // read the PREVIOUS arm's state, and "Make a new pairing code" would then
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
    void hostShowCode(engineRef.current).then(
      (made) => {
        if (stale()) return;
        setCode(made);
        // The arm is in. Only now is the slot the panel shows the live one.
        poll();
        pollRef.current = setInterval(poll, 1000);
      },
      (e: unknown) => {
        // A failed arm draws no code panel. The error note is the whole panel.
        if (!stale()) setError(e instanceof Error ? e.message : 'hosting failed');
      },
    );
    // The host panel names this device. The name comes from the engine, the
    // same source DashboardScreen reads.
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
  // keyed on the phase kind ALONE, so a codeRound change does not cancel.
  // Arming a new code replaces the slot, so a cancel that landed after the new
  // arm would disarm the code on screen. Only leaving code-host, or an unmount,
  // fires the cleanup.
  useEffect(() => {
    if (phase.kind !== 'code-host') return;
    return () => {
      void engineRef.current.cancelCodePairing().catch(() => {});
    };
  }, [phase.kind]);

  // Ruling 3: the picker takes no `paired` field. The flow removes the peers
  // this device already trusts, and passes the rest ready to draw.
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
        // The user left the camera screen (Cancel, or the system Back). That is
        // an answer, not a failed read: back to the choice, with no error.
        if ((e as { code?: unknown } | null)?.code === 'E_SCAN_CANCELLED') {
          setPhase({ kind: 'choose' });
          return;
        }
        setError(e instanceof Error ? e.message : 'scan failed');
      },
    );
  };

  // The third choice: the code panel. The flow opens it on the host side,
  // because the host is the device that shows a code.
  const startCode = () => {
    setSas('');
    setPeerId('');
    pendingRef.current = '';
    setError('');
    setConfirmError('');
    setCode('');
    setCodeStatus(undefined);
    setCodePick('');
    setPhase({ kind: 'code-host' });
  };

  // The segmented control inside the panel reads the mode and does not change
  // it (Task 5). This switch is the one control that changes it, so both halves
  // of code pairing are reachable: one device shows the code, the other types
  // it.
  const switchCodeMode = () => {
    setSas('');
    setPeerId('');
    pendingRef.current = '';
    setError('');
    setCodePick('');
    setPhase({ kind: phase.kind === 'code-join' ? 'code-host' : 'code-join' });
  };

  // The code is dead, or the user asked for a new one. The round bump arms a
  // fresh code: the phase kind does not change.
  const newCodeHost = () => {
    setSas('');
    setPeerId('');
    pendingRef.current = '';
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
    pendingRef.current = '';
    setError('');
    setConfirmError('');
    setCode('');
    setCodeStatus(undefined);
    setCodePick('');
    setCodeDevices([]);
    setPhase({ kind: 'choose' });
  };

  // The joiner typed six digits and pressed Continue. The screen disables
  // Continue while `codeBusy` is true, so a double tap calls the engine once.
  const submitCode = (digits: string) => {
    const deviceId = codePick;
    if (codeBusyRef.current) return;
    if (!deviceId) {
      setError('daak: pick the device that shows the code first');
      return;
    }
    codeBusyRef.current = true;
    setCodeBusy(true);
    setError('');
    void pairOrRevoke(deviceId, () => joinWithCode(engine, deviceId, digits)).then(
      ({ sas: received }) => {
        codeBusyRef.current = false;
        setCodeBusy(false);
        // Unmounted mid-pair: `pairOrRevoke` already revoked. Do not resurrect
        // the SAS on a dead route.
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

  // The screen takes one role and one code mode. The flow decides both.
  const hosting = phase.kind === 'host' || phase.kind === 'code-host';
  const codePhase = phase.kind === 'code-host' || phase.kind === 'code-join';

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
          {/* The third choice. It hides on a build that cannot run code
              pairing (spec Limits), so a daemon client shows two choices. */}
          {engine.codePairingSupported ? (
            <Btn variant="quiet" block testID="code" label="Use a pairing code" onPress={startCode} />
          ) : null}
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
        role={hosting ? 'host' : 'join'}
        qrUri={phase.kind === 'host' ? phase.qrUri : ''}
        onScan={startJoin}
        sas={sas}
        onConfirm={peerId ? confirm : undefined}
        onReject={peerId ? reject : undefined}
        embedded={embedded}
        busy={busy ?? undefined}
        error={error || undefined}
        onRetry={phase.kind === 'host' ? startHost : phase.kind === 'join' ? startJoin : undefined}
        // The design puts "Show a new code" under the number. The screen draws
        // it once a SAS is on it.
        onNewCode={hosting && sas ? (phase.kind === 'code-host' ? newCodeHost : startHost) : undefined}
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
        // The joiner picked this device, so it knows the name at the check
        // number. The host learns the name only from the finished handshake.
        peerName={
          phase.kind === 'code-join' ? codeDevices.find((d) => d.deviceId === codePick)?.name : undefined
        }
      />
      {/* The arm is one-shot. `startHost` arms again. Before a SAS arrives the
          screen shows no button of its own, so this one is the only recovery
          from a burnt arm. It goes once the screen draws its own button. */}
      {phase.kind === 'host' && !sas ? (
        <View style={pad}>
          <Btn variant="quiet" block testID="host-retry" label="Show a new code" onPress={startHost} />
        </View>
      ) : null}
      {/* The screen's panel shows the mode and cannot change it, so the flow
          carries the switch. Without it the joiner panel has no way in. */}
      {codePhase && !sas ? (
        <View style={pad}>
          <Btn
            variant="quiet"
            block
            testID="code-switch"
            label={phase.kind === 'code-host' ? 'Enter a code instead' : 'Show a code instead'}
            onPress={switchCodeMode}
          />
        </View>
      ) : null}
      {/* The panel draws a failure of the joiner call. The host arm has no note
          of its own, so the flow shows it here. A silent panel tells the user
          nothing. */}
      {phase.kind === 'code-host' && error ? (
        <View style={pad}>
          <Note tone="err" title="We couldn't make your code." body={error} testID="pair-code-host-error" />
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

