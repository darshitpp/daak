import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Btn, Note, PairingScreen, Section, ui, useEngine } from '@daak/ui';
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
export function PairingFlow({
  bundle,
  addr,
  embedded = false,
}: { bundle?: string; addr?: string; embedded?: boolean } = {}) {
  const engine = useEngine();
  const [phase, setPhase] = useState<Phase>({ kind: 'choose' });
  const [sas, setSas] = useState('');
  const [error, setError] = useState('');

  // The peer the SAS belongs to. The engine keeps a new pairing pending until
  // confirmPairing, so the screen needs the id to confirm or reject it.
  const [peerId, setPeerId] = useState('');

  useEffect(
    () =>
      onPairingSas((received, peer) => {
        setSas(received);
        setPeerId(peer);
      }),
    [],
  );

  // A link bundle IS a join, with no camera. But a link is a request from
  // another app or a web page, so it never joins by itself: the user sees who
  // is asking and taps Pair. Joined on bundle IDENTITY, not on mount: this
  // component is mounted whenever the pair route opens, so a plain mount effect
  // would re-pair a user who came here from Devices.
  const [link, setLink] = useState<{ parsed: ReturnType<typeof parsePairingPayload>; name: string } | null>(
    null,
  );

  useEffect(() => {
    setLink(null);
    if (!bundle) return;
    setSas('');
    setError('');
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
    // `addr` is the address, from the LINK first and the BUNDLE second.
    // Both name the same host and either can be absent: a deep link may
    // carry the bundle without an addr, and a bundle written by an older
    // build has no key. With neither, the engine resolves the host from
    // discovery, which is empty on any network mDNS does not cross.
    void engine
      .pair(parsed.deviceId, 'qr', parsed.cbor, addr ?? parsed.addr)
      .then(
        ({ sas: received }) => {
          setSas(received);
          setPeerId(parsed.deviceId);
        },
        (e: unknown) => setError(e instanceof Error ? e.message : 'that pairing link did not work'),
      );
  };

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
      // The REAL message, never a fixed string: "hosting failed" hides the
      // cause (a dead engine, a bridge that never settles) from the user and
      // from the next debugging round alike.
      (e: unknown) => setError(e instanceof Error ? e.message : 'hosting failed'),
    ).catch((e: unknown) =>
      setError(e instanceof Error ? e.message : 'arming failed'),
    );
  };

  const startJoin = () => {
    setSas('');
    setError('');
    setPhase({ kind: 'join' });
    void joinWithScan(engine).then(
      ({ sas: received, peerDeviceId }) => {
        setSas(received);
        setPeerId(peerDeviceId);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : 'scan failed'),
    );
  };

  // The engine keeps a new pairing pending: it grants nothing until the user
  // says the two SAS values matched. Reject removes the pending pairing.
  const reject = () => {
    const id = peerId;
    setSas('');
    setPeerId('');
    setPhase({ kind: 'choose' });
    setError('');
    if (id) {
      void engine.revokePairing(id).catch((e: unknown) =>
        setError(e instanceof Error ? e.message : 'could not remove the pairing'),
      );
    }
  };

  const confirm = () => {
    setError('');
    void engine.confirmPairing(peerId).then(
      () => {
        setSas('');
        setPeerId('');
        setPhase({ kind: 'choose' });
      },
      (e: unknown) => setError(e instanceof Error ? e.message : 'could not confirm the pairing'),
    );
  };

  // EMBEDDED is the onboarding case. PairFirstDeviceScreen already supplies an
  // appbar, a step counter and a scrolling column, so PairingScreen's own
  // frame -- its second appbar and its own ScrollView -- would nest one whole
  // screen inside another. Only the FRAME is suppressed; every control is the
  // same real one, which is the property that matters, because the alternative
  // would have been decorative QR data.
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
        <Section title="Pair with another Daak device">
          <Btn variant="primary" block testID="host" label="Show QR" onPress={startHost} />
          <Btn variant="quiet" block testID="join" label="Scan" onPress={startJoin} />
          {error ? <Note tone="err" testID="pairing-error" body={error} /> : null}
          <Note
            title="Nothing here leaves the network"
            body="Pairing shows a code and reads one back. No account, no server."
          />
        </Section>
      </View>
    );
  }
  return (
    // flex: 1 is load-bearing, the same as apps/desktop/src/pairing.tsx.
    // PairingScreen's own root IS ui.screen (flex: 1), so a wrapper with
    // automatic height collapses it -- and the QR with it -- to zero pixels.
    // The pair route then shows only the retry and back buttons, which reads
    // as a dead "Show QR". Reproduced on the iPhone 17 simulator.
    //
    // EMBEDDED keeps automatic height: OnboardingFlow owns the frame and puts
    // a sibling "Skip for now" button beside this flow, which a flex: 1 child
    // would push off screen.
    <View style={embedded ? undefined : ui.screen} testID="pair-frame">
      <PairingScreen
        role={phase.kind}
        qrUri={phase.kind === 'host' ? phase.qrUri : ''}
        onScan={startJoin}
        sas={sas}
        onConfirm={peerId ? confirm : undefined}
        onReject={peerId ? reject : undefined}
        embedded={embedded}
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
        {error ? <Note tone="err" testID="pairing-error" body={error} /> : null}
      </View>
    </View>
  );
}
