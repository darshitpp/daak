import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { DaakUiApp, useBlockers } from '@daak/ui';
import type { BlockerHost, IncompatiblePeer, SettingsHost, UiRuntime } from '@daak/ui';
// The @daak/core barrel re-exports NativeDaak, which calls
// TurboModuleRegistry.getEnforcing('Daak') at module-eval time and throws in
// Node. This specifier is a TYPE-only annotation, so it is erased at compile
// time and never evaluated at runtime.
import type { DaakEngine } from '@daak/core/src/engine/types';
import { useTrayOverlay } from '@daak/rn-tray';
import type { TrayAction } from '@daak/rn-tray';
import { closePopover, openDashboard, quitApp } from './window-host';
import { applyTrayAction } from './tray-action';
import { getDirectSharePeer, publishDevices, subscribeDirectSharePeer } from './direct-share';
import { desktopPickFiles } from './picker';
import { desktopInboxActions } from './inbox-actions';
import { appInfo, formatAppInfo, type AppInfo } from '@daak/platform/src/appinfo';
import { loadNotifyPrefs, saveNotifyPrefs } from '@daak/platform/src/notify-prefs';
import { DesktopOnboardingGate } from './onboarding-gate';
import { StartFaultNote } from './start-fault';
import { DesktopPairing } from './pairing';
// R42p: the download folder. Deep imports, not the @daak/platform barrel: that
// barrel re-exports every platform module and each resolves a TurboModule at
// module-eval time, which is the trap index.js:14-22 records.
import {
  chooseDownloadFolder,
  clearDownloadFolder,
  downloadFolderName,
} from '@daak/platform/src/fspaths';

// The peers the daemon reduced to "out of step", read off the SAME UiState the
// shell already subscribes to. A bare runtime.getState().incompatible would be
// a snapshot taken once: a peer that announces a bad version later would never
// reach the blocking hook. useSyncExternalStore is what re-renders on the next
// engine event, and it is the runtime's own subscription rather than a second
// engine.on (R43a).
//
// The fallback is a MODULE constant and never an inline []. useSyncExternalStore
// compares snapshots with Object.is, so an inline [] would hand back a new
// identity on every read and spin the tree forever -- the exact defect
// test/tray-survival.spec.ts records for the tray overlay. The real runtime
// (packages/ui/src/headless.ts) closes over initialUiState and always carries
// the field, so the fallback only serves a host that hands a narrower snapshot.
const NO_INCOMPATIBLE: IncompatiblePeer[] = [];

function useIncompatible(runtime: UiRuntime) {
  const subscribe = useCallback(
    (onChange: () => void) => runtime.subscribe(onChange),
    [runtime],
  );
  return useSyncExternalStore(
    subscribe,
    () => runtime.getState().incompatible ?? NO_INCOMPATIBLE,
  );
}

// R42p: the download folder verbs. VERBS only. The row in packages/ui owns the
// state, because a state update here would run the tray overlay hook again. One
// module constant serves the onboarding step and the Settings row.
const DOWNLOAD_FOLDER = {
  load: downloadFolderName,
  choose: chooseDownloadFolder,
  reset: clearDownloadFolder,
};

// Facts only this host knows. A module constant keeps its identity between renders.
const BLOCKER_HOST: BlockerHost = { deviceNoun: 'Mac', appInfo: () => appInfo() };

function onTrayAction(action: TrayAction): void {
  applyTrayAction(action, {
    closePopover,
    openDashboard,
    // The tray Quit reaches [NSApp terminate:nil] through RNWindowHost. The
    // engine's stop() is the wrong verb: it shuts DAEMOND down, and daakd is a
    // launchd service, so the app would stay in the menu bar with a dead
    // daemon. One value, one native verb, one place to change.
    quit: quitApp,
  });
}

// The DASHBOARD root owns the tray, and that is not a preference: at launch the
// dashboard root is the only one React mounts (RCTAppDelegate builds exactly
// one window, hosting DaakDashboard), and the popover root mounts only when the
// status item is clicked -- which cannot happen until install() has run, which
// is what install() is called from. A hook in the popover root is a deadlock.
// Exactly one root may own it, or install() runs twice and both copies
// subscribe to the same DaakTraySelect event.
//
// "Owns" means the DASHBOARD ROOT, which is why <DaakTrayOverlay/> sits beside
// the gate there rather than inside it: ownership is per-root, and a root that
// drops the overlay on a fault has dropped the only way back into a hidden
// window. See the comment at the mount site below.
export function DaakPopoverShell({ engine, runtime }: {
  engine: DaakEngine;
  runtime: UiRuntime;
}) {
  const incompatible = useIncompatible(runtime);
  const blockers = useBlockers(engine, incompatible, BLOCKER_HOST);
  // BOTH roots go through the gate, not just the dashboard. The popover is
  // reachable only after install() runs, which is after the tray exists, and a
  // first launch has no tray content worth opening -- but if it IS reachable,
  // rendering the dashboard against an unstarted engine would show an empty
  // device list with nothing explaining why.
  return (
    <View style={{ flex: 1 }}>
      <DesktopOnboardingGate downloadFolder={DOWNLOAD_FOLDER}>
        <StartFaultNote />
        <DaakUiApp
          mode="popover"
          engine={engine}
          runtime={runtime}
          onPickFiles={desktopPickFiles}
          alert={blockers.alert}
          alertRouteToken={blockers.alertRouteToken}
          settingsRouteToken={blockers.settingsRouteToken}
          onCheckConnection={blockers.onCheckConnection}
          onExpand={() => {
            closePopover();
            openDashboard();
          }}
        />
      </DesktopOnboardingGate>
    </View>
  );
}

export function DaakDashboardShell({ engine, runtime }: {
  engine: DaakEngine;
  runtime: UiRuntime;
}) {
  // The dashboard window is built at launch and only orderOut afterwards
  // (AppDelegate.mm), so a daak:// link arrives to a tree that is ALREADY
  // mounted. useState here would be seeded long before the event, and the link
  // would be retained but never applied -- precisely the failure the reviewer
  // called out. An external store read through useSyncExternalStore is what
  // lets an event arriving after mount re-render it.
  const subscribePeer = useCallback(
    (onChange: () => void) => subscribeDirectSharePeer(onChange),
    [],
  );
  const peerDeviceId = useSyncExternalStore(subscribePeer, getDirectSharePeer);
  // appInfo is async (P2). The window header reads it in an effect and shows
  // the version line after the answer. The About row reads it on its own.
  // Memoized: a new host object on every render would be harmless to
  // ArrivalSection (it depends on the functions), but it costs a re-render
  // of Settings for nothing. No osAlerts: the desktop has no stored OS answer
  // for alerts yet (open question in the P3 plan).
  const [info, setInfo] = useState<AppInfo | undefined>(undefined);
  useEffect(() => {
    void appInfo().then(setInfo, () => {});
  }, []);
  const settingsHost = useMemo<SettingsHost>(
    // Design v2: the Mac Connection card labels the row "Network".
    () => ({ appInfo, notifyPrefs: { load: loadNotifyPrefs, save: saveNotifyPrefs }, networkLabel: 'Network' }),
    [],
  );
  const windowChrome = useMemo(
    () => ({
      title: 'Daak for Mac',
      version: info !== undefined && info.version !== 'unknown' ? formatAppInfo(info) : undefined,
    }),
    [info],
  );
  const incompatible = useIncompatible(runtime);
  const blockers = useBlockers(engine, incompatible, BLOCKER_HOST);
  // The gate is a CONDITIONAL wrapper, not a boundary: both hooks above run
  // whether or not the dashboard is currently shown, and both read MODULE-level
  // stores rather than the engine. That is what lets the picker stay in this
  // component, where test/picker.spec.ts looks for it, instead of being pushed
  // into a child that only mounts once onboarding is done.
  //
  // The overlay is OUTSIDE the gate, and that is load-bearing rather than
  // tidiness. DesktopOnboardingGate REPLACES its children on every non-shell
  // phase -- a start fault swaps the dashboard for a fault note -- so an overlay
  // inside them unmounts with it, and NativeDaakTray.install()'s status item goes
  // with it. On a menu-bar app that is not a cosmetic loss: no Dock icon (LSUI
  // Element), no status item, and AppDelegate's orderOut window still hidden
  // leaves a dead engine with NO visible surface at all and no way back in.
  //
  // BEHAVIOUR CHANGE, accepted deliberately: the menu-bar item now exists during
  // first-run onboarding too. Its menu is built from runtime.getState(), which
  // during onboarding is the empty initial state, so it renders only 'Open
  // Dashboard' and 'Quit Daak' -- both safe, neither touching an unstarted
  // engine. That is also the only route back into a hidden window while the
  // engine is dead, which is the case this move exists for.
  //
  // STILL THE DASHBOARD ROOT ONLY. The popover root mounts only when the status
  // item is clicked, which cannot happen until install() has run; a second
  // install() would put two copies on the same DaakTraySelect subscription. See
  // the note above DaakPopoverShell.
  return (
    <>
      <TrayOverlay runtime={runtime} />
      <DesktopOnboardingGate downloadFolder={DOWNLOAD_FOLDER}>
        <StartFaultNote />
        <DaakUiApp
          mode="dashboard"
          engine={engine}
          runtime={runtime}
          peerDeviceId={peerDeviceId ?? undefined}
          onPickFiles={desktopPickFiles}
          inboxActions={desktopInboxActions}
          // ONLY the dashboard branch gets this, and deliberately. The popover
          // is three peers and a file box; pairing is a one-time setup step a
          // user reaches from Devices, and the popover has no route that could
          // carry one. Supplied on BOTH would render a second live engine.on
          // subscription for a screen nobody opens.
          pair={<DesktopPairing engine={engine} />}
          alert={blockers.alert}
          alertRouteToken={blockers.alertRouteToken}
          settingsRouteToken={blockers.settingsRouteToken}
          onCheckConnection={blockers.onCheckConnection}
          downloadFolder={DOWNLOAD_FOLDER}
          settingsHost={settingsHost}
          deviceNoun="Mac"
          windowChrome={windowChrome}
          toastBottomOffset={24}
        />
      </DesktopOnboardingGate>
    </>
  );
}

// The tray menu is built from the SAME UiState the tree below renders, and it
// is rebuilt by the hook's [devices, transfers] deps -- so a shell that read
// runtime.getState() once would freeze the menu at whatever the daemon had at
// launch and never list a peer that appears later.
//
// It lives in its own component rather than in DaakDashboardShell so that only
// this subscriber re-renders on an engine event. DaakUiApp has its own
// useSyncExternalStore; a second one in the shell would re-render the whole
// dashboard on every transfer.item in addition to the one that already does.
// Memoized at the call site. The version read in DaakDashboardShell re-renders
// that shell ONCE, when appInfo answers, and the tray overlay must not render
// with it: test/tray-survival.spec.ts counts its renders, and a re-render also
// rebuilds the native menu for nothing. `runtime` is stable, so memo skips it.
const TrayOverlay = React.memo(DaakTrayOverlay);

export function DaakTrayOverlay({ runtime }: { runtime: UiRuntime }) {
  // Keyed on [runtime]: an inline arrow is a new function every render, so
  // useSyncExternalStore would resubscribe on every event it just delivered.
  const subscribe = useCallback(
    (onChange: () => void) => runtime.subscribe(onChange),
    [runtime],
  );
  const state = useSyncExternalStore(subscribe, () => runtime.getState());
  // Feed the macOS Share menu. Republish ONLY on a devices-ARRAY identity
  // change: this component re-renders on every engine event, and transfer.item
  // fires once per file per batch, so an unconditional publish would serialise
  // the whole peer list into the native side many times a second for a list that
  // had not changed. reduceUiState already returns the SAME array when nothing
  // about the list moved (state/store.ts:30), so identity is a real signal
  // rather than a guess.
  useEffect(() => {
    void publishDevices(state.devices);
  }, [state.devices]);
  useTrayOverlay(state.devices, state.transfers, onTrayAction);
  return null;
}
