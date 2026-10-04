import React, { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeEngine } from '@daak/ui';

// THE MENU-BAR ICON SURVIVES A START FAULT. This is a RENDERED assertion.
//
// This app is a menu-bar app: Info.plist sets LSUIElement so there is no Dock
// icon, and AppDelegate.mm does [self.window orderOut:nil] at launch. Every
// route back into the UI runs through the status item. So when a start fault
// destroys the tray, the app has NO visible surface at all -- no icon, no
// status item, no window, and no way back in.
//
// THE DEFECT THIS PINS: DaakTrayOverlay used to live INSIDE
// DesktopOnboardingGate's children. The gate REPLACES children on every
// non-shell phase -- a start fault swaps the dashboard for a fault note -- so
// the overlay unmounted with it, and the status item install() created went with
// it. The fix moves the overlay OUT of the gate, beside it in
// DaakDashboardShell.
//
// WHY THIS IS RENDERED RATHER THAN A SOURCE PIN, PLAINLY: a source pin can only
// see the string DaakTrayOverlay somewhere in shells.tsx. It cannot see whether
// the element is inside or outside the gate's children -- and picker.spec.ts
// already records the general lesson (deleting both StartFaultNote calls left
// that file green at 8/8). A name in a file is not a component on screen. So
// the REAL DaakDashboardShell is mounted, with the REAL gate, in the real fault
// phase, and the assertion is on what the tray module was actually asked to do.
//
// WHY THAT IS OBSERVABLE WITHOUT DISTORTING PRODUCTION CODE: DaakTrayOverlay
// is EXPORTED. It was module-private, and making it a named export is a naming
// change, not a behaviour change -- the popover root's tree is byte-identical.

// The @daak/rn-tray barrel default-exports NativeDaakTray, a
// getEnforcing('DaakTray') that throws with no bridge -- the hazard
// src/window-host.ts and src/tray-action.ts both document. Mocked here because
// the assertion is about WHETHER the overlay mounted (which is what mounting
// DaakTrayOverlay calls), not about the native menu it then builds.
const overlayMounts: number[] = [];
vi.mock('@daak/rn-tray', () => ({
  useTrayOverlay: () => {
    overlayMounts.push(1);
  },
}));

import { DaakDashboardShell, DaakPopoverShell } from '../src/shells';
import { publishOnboardingDecision, resetOnboardingDecision } from '../src/onboarding-store';
import { reportStartFault, resetStartFault } from '../src/start-fault';

// A STABLE snapshot, and this is load-bearing rather than tidy.
//
// DaakTrayOverlay reads runtime.getState() through useSyncExternalStore, which
// compares snapshots with Object.is. A getState that built a fresh
// {devices: [], transfers: []} on every call hands back a new identity per
// render and spins the tree forever -- which is exactly what happened the first
// time this was written. The real runtime (packages/ui/src/headless.ts) closes
// over one state variable and returns the SAME object until an engine event
// changes it, so this mirrors the real contract rather than working around the
// test.
function stableRuntime() {
  const state = { devices: [], transfers: [] };
  return {
    getState: () => state,
    subscribe: () => () => {},
    prime: () => {},
  };
}

function render(Shell: typeof DaakDashboardShell | typeof DaakPopoverShell): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(Shell, { engine: fakeEngine([]), runtime: stableRuntime() as never }),
    );
  });
  return renderer;
}

function text(tree: ReactTestRenderer): string {
  return JSON.stringify(tree.toJSON() ?? null);
}

beforeEach(() => {
  resetOnboardingDecision();
  resetStartFault();
  overlayMounts.length = 0;
});

describe('the menu-bar status item survives a start fault', () => {
  it('keeps the tray mounted while dropping the live dashboard', () => {
    publishOnboardingDecision({ kind: 'ready' });
    reportStartFault(new Error('address already in use'));
    const tree = render(DaakDashboardShell);

    // The fault really did take the dashboard down. This is the negative half,
    // and without it a gate that rendered nothing at all would satisfy the
    // assertion below for the wrong reason.
    expect(text(tree)).toContain('address already in use');
    expect(text(tree)).not.toContain('Devices');
    // And the status item is still installed. The overlay is a SIBLING of the
    // gate, so the gate replacing its own children cannot reach it -- which is
    // the whole of the fix, observed rather than grepped.
    expect(overlayMounts).toHaveLength(1);
  });

  // The negative of the one above, without which the one above could pass over
  // a shell that never mounted the overlay in ANY phase.
  it('keeps the tray mounted on a healthy launch, so the fault case means something', () => {
    publishOnboardingDecision({ kind: 'ready' });
    render(DaakDashboardShell);
    expect(overlayMounts).toHaveLength(1);
  });

  it('keeps the tray mounted during first-run onboarding too', () => {
    // The accepted behaviour change, pinned so it stays a decision rather than
    // a drift: the status item now exists BEFORE onboarding finishes. Its menu
    // is built from runtime.getState() -- the empty initial state -- so it
    // renders only Open Dashboard and Quit Daak, both safe, neither touching an
    // unstarted engine. It is also the only route back into a hidden window
    // while the engine is dead, which is the case the move exists for.
    publishOnboardingDecision({ kind: 'onboard' });
    render(DaakDashboardShell);
    expect(overlayMounts).toHaveLength(1);
  });

  it('keeps the tray mounted when the keystore read itself failed', () => {
    // The other terminal non-shell phase, and the one a first launch can reach
    // before any engine start has been attempted.
    publishOnboardingDecision({ kind: 'fault', message: 'keychain locked' });
    render(DaakDashboardShell);
    expect(overlayMounts).toHaveLength(1);
  });

  it('leaves the tray to the dashboard root alone', () => {
    // The popover root must NOT mount the overlay. The dashboard root is the
    // only one React mounts at launch, so a second install() here would put two
    // status items up and two copies on the same DaakTraySelect subscription.
    publishOnboardingDecision({ kind: 'ready' });
    render(DaakPopoverShell);
    expect(overlayMounts).toEqual([]);
  });
});
