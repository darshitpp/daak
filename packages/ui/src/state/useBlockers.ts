import React, { createElement, useCallback, useEffect, useRef, useState } from 'react';
import { Linking } from 'react-native';
import type { DaakEngine } from '@daak/core';
import { CantReachScreen, type QueuedTransfer } from '../screens/CantReachScreen';
import { UpdateRequiredScreen, type AppVersion } from '../screens/UpdateRequiredScreen';
import { RELEASES_URL } from '../screens/about-links';
import type { DeviceNoun } from '../components/ds';
import type { IncompatiblePeer } from './store';

/**
 * THE BLOCKING FACTS, ONCE.
 *
 * This hook owns the two prototype screens the desktop could not reach:
 * Update Required and Cant Reach. It is the SAME logic the mobile host used to
 * carry in apps/mobile/src/App.tsx, moved here so there is one implementation,
 * one behaviour and one route table (R43c). Mobile and desktop each held their
 * own copy, and the desktop copy did not exist: `grep -rn
 * 'UpdateRequiredScreen|CantReachScreen' apps/desktop` returned nothing, so the
 * macOS build rendered 11 of the prototype's 13 screens.
 *
 * It takes the engine and the ALREADY REDUCED incompatible list. It never
 * subscribes to the engine itself: a second engine.on in host code is exactly
 * the defect that doubles an event, and the peers already arrive reduced on the
 * UiState every host reads (R43a).
 *
 * packages/ui stays free of platform code here. The only engine calls are the
 * two every DaakEngine already carries.
 */

/**
 * Facts that only the host knows. They enter as data because `packages/ui` has
 * no platform check. A host builds one module constant and passes it, so the
 * object keeps its identity between renders.
 */
export interface BlockerHost {
  /** The word for this device in the copy. 'phone' on mobile, 'Mac' on desktop. Default 'device'. */
  deviceNoun?: DeviceNoun;
  /** Reads the app version. May be sync or async, and may reject. */
  appInfo?: () => AppVersion | Promise<AppVersion>;
  /** Opens a web page. Default: Linking.openURL. The app makes no request itself (ruling D2). */
  openUrl?: (url: string) => void | Promise<unknown>;
}

export function useBlockers(
  engine: DaakEngine,
  incompatible: IncompatiblePeer[],
  host?: BlockerHost,
): {
  alert: React.ReactNode | undefined;
  alertRouteToken: string | undefined;
  settingsRouteToken: string | undefined;
  onCheckConnection: () => void;
} {
  // Peers announcing a protocol version this build refuses, and the token that
  // opens the Update Required screen for them.
  //
  // The engine SKIPS an incompatible peer rather than listing it, so without
  // this the only symptom of a version mismatch is a network that looks empty
  // -- indistinguishable from "nobody is home". The token is a STRING, not a
  // boolean, because the same peer re-announces on a timer: a boolean would
  // re-open the screen every few seconds after the user dismissed it.
  const [updateToken, setUpdateToken] = useState<string | undefined>(undefined);
  // Every peer this build has already opened Update Required for, for the life
  // of the hook. A REF and not state: the effect below reads it inside the same
  // synchronous event callback that writes it, and a state read there would be
  // the render-before-this-one value -- so a peer re-announcing in the same tick
  // as its first announcement would be treated as new and re-open a screen the
  // user dismissed. It also keeps a setState call out of a setState updater,
  // which StrictMode double-invokes.
  const shownPeers = useRef<Set<string>>(new Set());
  // Why the can't-reach screen is showing, or undefined when it is not. A
  // STRING and not a flag for the same reason: the reason IS the identity of the
  // condition, so two different failures do not collapse into one.
  const [noDevices, setNoDevices] = useState<string | undefined>(undefined);
  const [retrying, setRetrying] = useState(false);
  // The host object can be a new value on every render. The effect below reads
  // it through a ref, so a new identity never loads the version again. With the
  // host in the dependency list, each load would call `setApp` with a new
  // object, which renders again, which builds a new host, which loads again.
  const hostRef = useRef(host);
  hostRef.current = host;
  const [app, setApp] = useState<AppVersion | undefined>(undefined);
  const [queued, setQueued] = useState<QueuedTransfer[]>([]);
  // Bumped when a blocking screen's "Open Settings" fires. The shell reads it
  // and selects the Settings tab, so the button lands where it says it does.
  const [settingsToken, setSettingsToken] = useState(0);

  // The peers ARRIVE from the host rather than from an engine listener here,
  // so this is a list-derived effect and not a subscription. Only a peer that
  // has NEVER been shown the screen opens it: a repeat announcement is the same
  // fact restated, and re-opening on it would make the screen impossible to
  // dismiss -- the peer announces on a timer, so "Remind me later" would last a
  // few seconds. Every peer is recorded, whether or not it opened anything, so
  // a peer that arrives and leaves cannot slip past the set.
  // The screen is a notice and not a blocker, because sending still works.
  useEffect(() => {
    for (const peer of incompatible) {
      if (shownPeers.current.has(peer.peerDeviceId)) continue;
      shownPeers.current.add(peer.peerDeviceId);
      // A peer that is behind means this app is the newer one. No download
      // exists for this user, so the notice stays closed.
      // This comparison is the only use of `peerVersion` and `ourVersion`.
      // The screen shows no protocol number.
      if (peer.peerVersion <= peer.ourVersion) continue;
      setUpdateToken(peer.peerDeviceId);
    }
  }, [incompatible]);

  // The app version loads when the screen opens. A missing or failing source
  // leaves the "This app" row out. The screen is complete without it.
  useEffect(() => {
    if (updateToken === undefined) return;
    let live = true;
    void Promise.resolve()
      .then(() => hostRef.current?.appInfo?.())
      .catch(() => undefined)
      .then((a) => {
        if (live) setApp(a ?? undefined);
      });
    return () => {
      live = false;
    };
    // `updateToken` is the only trigger. `hostRef` is stable.
  }, [updateToken]);

  /**
   * The prototype's "Waiting to send" block, as the REAL outbox.
   *
   * Nothing here is synthesised: this screen's promise is that nothing is lost,
   * and a made-up queue would prove nothing about that promise. The engine's
   * transfer summary carries no display name, so the label is the peer id it is
   * waiting for -- real, and honest about being an id.
   */
  const pendingOutbox = useCallback(async (): Promise<QueuedTransfer[]> => {
    try {
      const transfers = await engine.listTransfers();
      return transfers
        .filter((t) => t.state !== 'done' && t.state !== 'failed')
        .map((t) => ({
          transferId: t.transferId,
          label: 'To ' + t.peerDeviceId.slice(0, 8),
          bytesTotal: t.bytesTotal,
        }));
    } catch {
      return [];
    }
  }, [engine]);

  /**
   * Asks the engine whether anybody is out there, and records the answer as the
   * can't-reach reason when the honest answer is "no".
   *
   * Two DIFFERENT failures produce one screen with different text, because they
   * are different problems and merging them would name the wrong one:
   *
   *  - devices() REJECTS: the check itself failed. The engine is up but not
   *    answering. Shown as an error on the screen rather than as "nobody is
   *    home", because we do not actually know that.
   *  - devices() resolves EMPTY: discovery really did find nobody.
   *
   * The outbox rows are the REAL listTransfers() output, filtered to transfers
   * that are still waiting. Nothing here is synthesised.
   *
   * RETURNS the outcome instead of only recording it, because the caller has to
   * act on "somebody IS there" differently from "nobody is there".
   */
  const checkReachability = useCallback(async (): Promise<'reachable' | 'empty' | 'failed'> => {
    // The verdict AND the engine's own words, as ONE value. A reason that lived
    // in a separate state could be written twice and read between the writes,
    // and this screen would show one failure's words beside another's queue.
    let reason: string | undefined;
    let outcome: 'reachable' | 'empty' | 'failed' = 'reachable';
    try {
      const devices = await engine.devices();
      if (devices.length > 0) {
        // Deliberately NOT an early return. Retry has to refresh the QUEUE as
        // well as the answer: the screen it just dismissed can come back with
        // stale rows, and a user who tapped Retry to clear a stuck send would
        // see the same stuck send again. Every path falls through to the one
        // pendingOutbox() call instead, and `reason` stays undefined -- which is
        // exactly the "reachable" sentinel setNoDevices is given below.
        outcome = 'reachable';
      } else {
        reason = 'empty';
        outcome = 'empty';
      }
    } catch (e) {
      // A rejected check is NOT "nobody is home"; it is the check failing, and
      // the screen says so in its own note rather than blaming the network.
      reason = 'failed:' + (e instanceof Error ? e.message : String(e));
      outcome = 'failed';
    }
    // The rows BEFORE the reason, in one batch, because one render cannot show a
    // reason the queue does not belong to. A rejected list is an empty list: the
    // screen's claim is that nothing is LOST, and a queue it cannot read is not
    // evidence either way.
    const rows = await pendingOutbox();
    setQueued(rows);
    setNoDevices(reason);
    return outcome;
  }, [engine, pendingOutbox]);

  /**
   * The prototype's "...isn't showing? See what to check" affordances, on the
   * Devices tab and in Settings. This is the ONLY thing that opens the can't-
   * reach screen.
   *
   * It was an effect once, running devices() on every launch and routing to Cant
   * Reach whenever the answer came back empty. That is not true: Daak answers
   * "nobody" on a perfectly healthy LAN whenever the other device is asleep, so
   * every user with one paired device saw a "Daak can't reach any devices" wall
   * instead of their app. The check is a question the user asked, so it runs
   * when they ask it (R43b).
   */
  const openReachabilityCheck = useCallback(() => {
    void checkReachability().then((outcome) => {
      if (outcome === 'reachable') setNoDevices(undefined);
    });
  }, [checkReachability]);

  const retryReachability = useCallback(() => {
    setRetrying(true);
    void checkReachability().finally(() => setRetrying(false));
  }, [checkReachability]);

  /**
   * "Open Settings" from either blocking screen. Clears the alert AND bumps the
   * settings route in the same batch, so the dismissal and the tab switch land
   * together -- and bumps the TOKEN, so asking twice works twice, which a boolean
   * would refuse.
   *
   * The update notice closes with onDismiss only. Dismissing is not consent to
   * be navigated, and the peer is already in shownPeers, so its next
   * announcement will not put the screen back up.
   */
  const openSettingsFromAlert = useCallback(() => {
    setUpdateToken(undefined);
    setNoDevices(undefined);
    setSettingsToken((n) => n + 1);
  }, []);

  // Which blocking screen, if any, is showing. Update Required wins: a peer on a
  // different protocol version is a definite fact the engine has told us, while
  // an empty device list may simply be that nobody is home yet.
  const alert =
    updateToken !== undefined ? (
      // createElement, not JSX: this file is named .ts, and no other module in
      // packages/ui puts JSX in a .ts file. ponytail: one line of ceremony is
      // cheaper than renaming a path three trees depend on.
      createElement(UpdateRequiredScreen, {
        app,
        onDismiss: () => setUpdateToken(undefined),
        onOpenDownloadPage: () =>
          host?.openUrl !== undefined ? host.openUrl(RELEASES_URL) : Linking.openURL(RELEASES_URL),
      })
    ) : noDevices !== undefined ? (
      createElement(CantReachScreen, {
        queued,
        retrying,
        error: noDevices.startsWith('failed:') ? noDevices.slice('failed:'.length) : '',
        onRetry: retryReachability,
        onOpenSettings: openSettingsFromAlert,
        deviceNoun: host?.deviceNoun,
      })
    ) : undefined;

  return {
    alert,
    alertRouteToken: updateToken ?? (noDevices === undefined ? undefined : 'cant-reach'),
    // 0 means nothing asked yet, and a token of '0' would route Settings on
    // mount. undefined is the honest resting value.
    settingsRouteToken: settingsToken === 0 ? undefined : String(settingsToken),
    onCheckConnection: openReachabilityCheck,
  };
}
