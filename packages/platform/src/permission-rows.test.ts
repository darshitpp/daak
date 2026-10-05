import { describe, expect, it, vi } from 'vitest';

vi.mock('@daak/rn-notify', () => ({
  default: {
    requestPermission: vi.fn(async () => true),
    registerCategories: vi.fn(async () => true),
  },
}));

import NativeDaakNotify from '@daak/rn-notify';
import {
  ALERTS_TITLE,
  DISCOVERY_TITLE,
  NETWORK_TITLE,
  permissionRows,
  withNotificationReask,
} from './permission-rows';

const notify = vi.mocked(NativeDaakNotify);

describe('permission rows are only as switchable as the platform really is', () => {
  // The two rows this build cannot change are the ones a reviewer will look at
  // first: there is no JS API for either, and a Pressable on them would be a
  // control that changes nothing.
  it('reports discovery and local network instead of offering a switch for them', () => {
    const { rows } = permissionRows({ notificationsGranted: true });
    const nearby = rows.find((r) => r.key === 'nearby');
    const network = rows.find((r) => r.key === 'network');
    expect(nearby?.title).toBe(DISCOVERY_TITLE);
    expect(network?.title).toBe(NETWORK_TITLE);
    // The engine starts discovery inside engine.start() and DaakEngine has no
    // stopDiscovery, so these are facts rather than grants.
    expect(nearby?.onPress).toBeUndefined();
    expect(network?.onPress).toBeUndefined();
    // And UNAVAILABLE rather than ON, which is the substantive change: an iOS
    // local-network refusal cannot be queried from JS, so a switch rendered ON
    // would claim a grant the user may have refused in the system prompt.
    expect(nearby?.state).toBe('unavailable');
    expect(network?.state).toBe('unavailable');
    // The subtitle has to carry the reason, because the control itself cannot.
    expect(nearby?.sub).toContain('cannot turn this off');
    expect(network?.sub).toContain('cannot check the answer');
  });

  // The prototype's third switch is titled "Sound when a file arrives". There
  // is no sound preference anywhere in this codebase, and naming one would
  // promise a setting Daak does not have.
  it('does not claim a sound preference this build cannot grant', () => {
    expect(ALERTS_TITLE).not.toContain('Sound');
    expect(ALERTS_TITLE).toBe('Alerts when a file arrives');
  });

  it('renders the alerts row from the real OS answer, not a guess', () => {
    expect(permissionRows({ notificationsGranted: true }).rows[2]?.state).toBe('on');
    expect(permissionRows({ notificationsGranted: false }).rows[2]?.state).toBe('off');
    // "Not asked yet" is a first-launch state and must not render as granted.
    expect(permissionRows({}).rows[2]?.state).toBe('off');
  });

  // The Continue gate names only what the user can actually act on. Listing
  // discovery or local network there would promise that pressing something on
  // this screen would change them.
  it('unblocks Continue only once the askable permission is answered', () => {
    expect(permissionRows({ notificationsGranted: true }).stillNeeded).toEqual([]);
    expect(permissionRows({ notificationsGranted: false }).stillNeeded).toEqual([ALERTS_TITLE]);
    expect(permissionRows({}).stillNeeded).toEqual([ALERTS_TITLE]);
  });

  // A declined notification permission is an ORDINARY answer (R36), not an
  // error: the inbox is the source of truth, so a denied permission costs a
  // banner and never a transfer.
  it('says a denied banner costs nothing but the banner', () => {
    const row = permissionRows({ notificationsGranted: false }).rows[2];
    expect(row?.sub).toContain('Files still arrive');
  });

  it('re-asks for real and reports the answer the platform gives back', async () => {
    const answers: boolean[] = [];
    const rows = withNotificationReask({ notificationsGranted: false }, (a) => answers.push(a));
    const alerts = rows.find((r) => r.key === 'alerts');
    notify.requestPermission.mockResolvedValueOnce(true);
    alerts?.onPress?.();
    await vi.waitFor(() => expect(answers).toEqual([true]));
    // The value rendered afterwards is the OS's own, not a local guess.
    expect(notify.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('reports a rejected ask as a denial rather than throwing into the render', async () => {
    const answers: boolean[] = [];
    const rows = withNotificationReask({}, (a) => answers.push(a));
    notify.requestPermission.mockRejectedValueOnce(new Error('no foreground activity'));
    rows.find((r) => r.key === 'alerts')?.onPress?.();
    await vi.waitFor(() => expect(answers).toEqual([false]));
  });
});
