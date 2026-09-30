import React, { useCallback, useSyncExternalStore } from 'react';
import { DaakUiApp } from '@daak/ui';
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
    <DaakUiApp
      mode="popover"
      engine={engine}
      runtime={runtime}
      onExpand={() => {
        closePopover();
        openDashboard();
      }}
    />
  );
}

export function DaakDashboardShell({ engine, runtime }: {
  engine: DaakEngine;
  runtime: UiRuntime;
}) {
  return (
    <>
      <DaakTrayOverlay runtime={runtime} />
      <DaakUiApp mode="dashboard" engine={engine} runtime={runtime} />
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
  useTrayOverlay(state.devices, state.transfers, onTrayAction);
  return null;
}
