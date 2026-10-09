import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { Btn, Note, PairingScreen, Section } from '@daak/ui';
import type { DaakEngine } from '@daak/core/src/engine/types';
// Deep imports, NOT the @daak/platform barrel, for the reason index.js:14-22
// already records: that barrel re-exports every platform module, each of which
// runs TurboModuleRegistry.getEnforcing at module-eval time. The desktop
// registers only Daak, DaakSystemShare, DaakSystemNotify, the window/tray
// modules and -- from this task -- DaakQrScanner. Two named functions are
// reached instead of pulling the whole surface in and throwing on the first
// module that has no desktop implementation.
import { pairingBundle } from '@daak/platform/src/pairing';

type Phase = { kind: 'idle' } | { kind: 'host'; qrUri: string };

/**
 * The desktop HOST half of pairing, and only that half.
 *
 * The QR flow is asymmetric: only the JOINER scans. The Mac shows a code, the
 * phone scans it, and the host then arms its accept slot from that same display
 * -- no camera, and no scanned bundle, because only the joiner ever holds a
 * bundle. A camera permission prompt on a Mac that is only holding up a QR
 * would ask for a permission the app never uses, so scanQr() is never imported.
 *
 * Without this route the desktop could not pair at all: DaakDashboardShell
 * passes no `pair` slot, so AppShell's pair route renders nothing, and the
 * outbox drain then refuses every send at "peer is not paired"
 * (crates/daak-core/src/engine.rs). Nothing about the transport is wrong.
 *
 * The SAS subscription is OWNED HERE, not in a second engine.on above: this
 * component mounts only while the pair route is open and unsubscribes on
 * unmount, so the subscription exists exactly when something reads it. The
 * desktop has no pairing fan-out registry because it has no second reader.
 */
export function DesktopPairing({ engine }: { engine: DaakEngine }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [sas, setSas] = useState('');
  const [peerId, setPeerId] = useState('');
  const [error, setError] = useState('');

  const onEvent = useCallback(
    (event: { type: string; sas?: string; deviceId?: string }) => {
      if (event.type === 'pairing.sas' && typeof event.sas === 'string') setSas(event.sas);
      // Stored before the SAS shows; kept so a SAS that does not match can remove it.
      if (event.type === 'pairing.done' && typeof event.deviceId === 'string') setPeerId(event.deviceId);
    },
    [],
  );

  // The SAS did not match: remove the pairing the engine already stored.
  const reject = () => {
    const id = peerId;
    setSas('');
    setPeerId('');
    setPhase({ kind: 'idle' });
    setError('');
    if (id) {
      void engine.revokePairing(id).catch((e: unknown) =>
        setError(e instanceof Error ? e.message : 'could not remove the pairing'),
      );
    }
  };
  useEffect(() => engine.on(onEvent), [engine, onEvent]);

  const showQr = () => {
    setSas('');
    setError('');
    // The qr module is required LAZILY, here, and not imported at the top. That
    // import is not a type: js/NativeDaakQrScanner.ts calls
    // TurboModuleRegistry.getEnforcing('DaakQrScanner') at MODULE EVAL, so a
    // top-level import makes the WHOLE app fail to boot whenever that pod is
    // not linked -- the same trap index.js:14-22 and notify.ts:110 both record.
    // It would take the dashboard down with the pairing screen rather than the
    // one button that needs the module.
    //
    // pairingBundle stays a top-level import on purpose: it is pure JS over the
    // 'Daak' module, which this app already registers and already loads.
    const qr = require('@daak/platform/src/qr') as typeof import('@daak/platform/src/qr');
    // Lazy: nothing fetches a bundle or renders a QR until the user asks, so a
    // launch never pays for a code nobody looks at.
    //
    // The arm follows the QR rather than leading it, because arming is a local
    // state change with no reply: a joiner that dials before the code is on
    // screen is refused as unpaired and retries, which is the same window every
    // engine-side arm has. A joiner can only scan a code that is already shown,
    // so this order has no reachable race the other one would have avoided.
    void pairingBundle()
      .then((bundle) => qr.generateQr(bundle, qr.PAIRING_QR_SIZE))
      .then(
        async (qrUri) => {
          setPhase({ kind: 'host', qrUri });
          await engine.armHostPairing();
        },
        (e: unknown) => setError(e instanceof Error ? e.message : 'could not make a pairing code'),
      )
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : 'could not arm pairing'),
      );
  };

  if (phase.kind === 'idle') {
    return (
      <View style={{ padding: 16, gap: 24 }}>
        <Section title="Pair with another Daak device">
          <Btn variant="primary" block testID="host" label="Show QR" onPress={showQr} />
          {error ? <Note tone="err" testID="pairing-error" body={error} /> : null}
          <Note
            title="Nothing here leaves the network"
            body="Pairing shows a code on this Mac. The other device reads it with its camera. No account, no server."
          />
        </Section>
      </View>
    );
  }

  return (
    // flex: 1 is load-bearing. PairingScreen's own root IS ui.screen
    // (flex: 1), and this view had automatic height, so the QR -- and the
    // appbar above it -- resolved to zero pixels. The Mac showed the pair
    // route with no code at all, which reads as a dead button. The parent
    // in AppShell is flex: 1, so the flex has a space to fill.
    <View style={{ flex: 1 }}>
      <PairingScreen
        role="host"
        qrUri={phase.qrUri}
        onScan={showQr}
        sas={sas}
        onReject={peerId ? reject : undefined}
      />
      {/* The arm is ONE-SHOT: the engine takes it for the first joiner, and a
          stray LAN connection can spend it without the user. One button
          re-arms, which is the whole recovery path. Shown before any SAS has
          arrived, because that is the state a spent arm leaves behind. */}
      <View style={{ padding: 16, gap: 24 }}>
        <Btn variant="quiet" block testID="host-retry" label="Show a new QR" onPress={showQr} />
        {error ? <Note tone="err" testID="pairing-error" body={error} /> : null}
      </View>
    </View>
  );
}
