import { describe, expect, it, vi } from 'vitest';
import { applyTrayAction, planTrayAction } from '../src/tray-action';

// The tray action is the ONE place where a menu id turns into a decision about
// a window, and the decisions are not the same: 'quit' must NOT open the
// dashboard, and 'send'/'transfer' must carry the id the menu minted rather than
// collapsing into a bare open. So the dispatch is split from the effects and
// the effects are injected, which is the only way a vitest suite in this
// package (environment: 'node', no react-native runtime) can reach it at all.
describe('planTrayAction', () => {
  it('quits without touching a window', () => {
    expect(planTrayAction({ kind: 'quit' })).toEqual({ kind: 'quit' });
  });

  it('opens the dashboard on its own', () => {
    expect(planTrayAction({ kind: 'dashboard' })).toEqual({ kind: 'open-dashboard' });
  });

  // send: and transfer: are now INDISTINGUISHABLE from 'dashboard' on purpose.
  // The id used to survive planTrayAction and then die in applyTrayAction,
  // because openDashboard() takes no argument -- a carry nobody read, pinned by
  // the two tests above. ponytail: 'tray send focused on a specific peer' is
  // deferred to the task that plumbs it into dashboard initial props.
  it('opens a plain dashboard for a send, with no id to carry', () => {
    expect(planTrayAction({ kind: 'send', deviceId: 'abc' }))
      .toEqual({ kind: 'open-dashboard' });
  });

  it('opens a plain dashboard for a transfer, with no id to carry', () => {
    expect(planTrayAction({ kind: 'transfer', transferId: 't1' }))
      .toEqual({ kind: 'open-dashboard' });
  });

  it('never both closes and opens for a quit', () => {
    const closePopover = vi.fn();
    const openDashboard = vi.fn();
    const quit = vi.fn();
    applyTrayAction({ kind: 'quit' }, { closePopover, openDashboard, quit });
    expect(quit).toHaveBeenCalledOnce();
    expect(openDashboard).not.toHaveBeenCalled();
    expect(closePopover).not.toHaveBeenCalled();
  });

  it('closes the popover before opening the dashboard for every other kind', () => {
    const calls: string[] = [];
    const host = {
      closePopover: () => calls.push('close'),
      openDashboard: () => calls.push('open'),
      quit: () => calls.push('quit'),
    };
    for (const action of [
      { kind: 'dashboard' } as const,
      { kind: 'send', deviceId: 'a' } as const,
      { kind: 'transfer', transferId: 't' } as const,
    ]) {
      calls.length = 0;
      applyTrayAction(action, host);
      expect(calls).toEqual(['close', 'open']);
    }
  });
});
