import React, { useCallback, useEffect, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { DaakUiApp, Note } from '@daak/ui';
import type { UiRuntime } from '@daak/ui';
// The @daak/core barrel re-exports NativeDaak, which calls
// TurboModuleRegistry.getEnforcing('Daak') at module-eval time and throws in
// Node. This specifier is a TYPE-only annotation, so it is erased at compile
// time and never evaluated at runtime.
import type { DaakEngine } from '@daak/core/src/engine/types';
import { useTrayOverlay } from '@daak/rn-tray';
import type { TrayAction } from '@daak/rn-tray';
import { closePopover, openDashboard } from './window-host';
import { applyTrayAction } from './tray-action';
import { getDirectSharePeer, publishDevices, subscribeDirectSharePeer } from './direct-share';
import { desktopPickFiles } from './picker';
import { desktopInboxActions } from './inbox-actions';

// A dead engine says nothing on screen: no peers, no transfers, no inbox, and
// no error -- the same reason apps/mobile/src/App.tsx shows a note for it. A
// module-level store rather than state because the roots are registered with
// AppRegistry and cannot be handed a prop when start() rejects later.
let startFault: string | null = null;
const faultListeners = new Set<() => void>();

export function startFaultMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function reportStartFault(error: unknown): void {
  startFault = startFaultMessage(error);
  faultListeners.forEach((listener) => listener());
}

function StartFaultNote() {
  const fault = useSyncExternalStore(
    useCallback((onChange: () => void) => {
      faultListeners.add(onChange);
      return () => faultListeners.delete(onChange);
    }, []),
    () => startFault,
  );
  if (fault === null) return null;
  return (
    <View style={{ padding: 16, paddingBottom: 0 }}>
      <Note
        tone="err"
        title="Daak's engine did not start"
        body={`Nothing can be sent or received until this is fixed: ${fault}`}
      />
    </View>
  );
}

function onTrayAction(action: TrayAction): void {
  applyTrayAction(action, {
    closePopover,
    openDashboard,
    // ponytail: no plan gives quitting this menu-bar app an owner, and the
    // engine's stop() would shut DAEMOND down instead. One line, in one place,
    // so the assignment is a change to a value and not a new code path.
    quit: () => {},
  });
}

// The DASHBOARD root owns the tray, and that is not a preference: at launch the
// dashboard root is the only one React mounts (RCTAppDelegate builds exactly
// one window, hosting DaakDashboard), and the popover root mounts only when the
// status item is clicked -- which cannot happen until install() has run, which
// is what install() is called from. A hook in the popover root is a deadlock.
// Exactly one root may own it, or install() runs twice and both copies
// subscribe to the same DaakTraySelect event.
export function DaakPopoverShell({ engine, runtime }: {
  engine: DaakEngine;
  runtime: UiRuntime;
}) {
  return (
    <View style={{ flex: 1 }}>
      <StartFaultNote />
      <DaakUiApp
        mode="popover"
        engine={engine}
        runtime={runtime}
        onPickFiles={desktopPickFiles}
        onExpand={() => {
          closePopover();
          openDashboard();
        }}
      />
    </View>
  );
}

export function DaakDashboardShell({ engine, runtime }: {
  engine: DaakEngine;
  runtime: UiRuntime;
}) {
  // The dashboard window is built at launch and only orderOut afterwards
  // (AppDelegate.mm), so a daak:// link arrives at a tree that is ALREADY
  // mounted. useState here would be seeded long before the event, and the link
  // would be retained but never applied -- precisely the failure the reviewer
  // called out. An external store read through useSyncExternalStore is what
  // lets an event arriving after mount re-render it.
  const subscribePeer = useCallback(
    (onChange: () => void) => subscribeDirectSharePeer(onChange),
    [],
  );
  const peerDeviceId = useSyncExternalStore(subscribePeer, getDirectSharePeer);
  return (
    <>
      <StartFaultNote />
      <DaakTrayOverlay runtime={runtime} />
      <DaakUiApp
        mode="dashboard"
        engine={engine}
        runtime={runtime}
        peerDeviceId={peerDeviceId ?? undefined}
      onPickFiles={desktopPickFiles}
      inboxActions={desktopInboxActions}
      />
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
function DaakTrayOverlay({ runtime }: { runtime: UiRuntime }) {
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
