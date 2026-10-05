// A TYPE-only import on purpose. The @daak/rn-tray barrel re-exports
// NativeDaakTray, which calls TurboModuleRegistry.getEnforcing('DaakTray') at
// module-eval time and throws with no bridge. This module is loaded by vitest
// in a plain node environment, so the spec must never be evaluated here.
import type { TrayAction } from '@daak/rn-tray';

// The decision, separated from the effects. The plan's TrayAction is four
// kinds; the window operations are not the same for all four (quit touches no
// window at all), so collapsing the handler into one function left 'quit'
// indistinguishable from 'dashboard' at the call site.
export type TrayActionPlan =
  | { kind: 'quit' }
  | { kind: 'open-dashboard' };

export function planTrayAction(action: TrayAction): TrayActionPlan {
  if (action.kind === 'quit') return { kind: 'quit' };
  // 'send' and 'transfer' are the SAME effect as 'dashboard': openDashboard()
  // takes no argument, so an id carried here is read by nobody. The previous
  // version kept the fields and a test pinned the carry -- a promise no code
  // could keep. ponytail: focus the dashboard on a specific peer when the host
  // can pass the id through as dashboard initial props; until then the menu
  // item's label is the only thing distinguishing them, and that is honest.
  return { kind: 'open-dashboard' };
}

export interface TrayHost {
  closePopover(): void;
  openDashboard(): void;
  quit(): void;
}

export function applyTrayAction(action: TrayAction, host: TrayHost): void {
  const plan = planTrayAction(action);
  if (plan.kind === 'quit') {
    // There is no Quit verb on the engine, and DaemonClientEngine.stop() sends
    // IpcRequest::Shutdown, which shuts DAEMOND down -- not this menu-bar app.
    // The owner is the window host: RNWindowHost's quitApp calls
    // [NSApp terminate:nil], which is the same selector the app menu's Quit
    // Daak item already sends. This layer still calls the host and names no
    // effect of its own, so the decision and the effect stay separable.
    host.quit();
    return;
  }
  // Close before open: the popover is transient and anchored to the status
  // item, and openDashboard also activates the app, so opening first would
  // leave the popover on screen over the window it just opened.
  host.closePopover();
  host.openDashboard();
}
