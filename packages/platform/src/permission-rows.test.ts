import { describe, expect, it, vi } from 'vitest';

vi.mock('@daak/rn-notify', () => ({
  default: {
    requestPermission: vi.fn(async () => true),
    registerCategories: vi.fn(async () => true),
  },
}));

import NativeDaakNotify from '@daak/rn-notify';
import { ALERTS_SUB, ALERTS_TITLE, permissionRows, withNotificationReask } from './permission-rows';

const notify = vi.mocked(NativeDaakNotify);

describe('permission rows', () => {
  // The design has one row on the Permissions step. Discovery and local network
  // are not user choices, so the step does not list them.
  it('has one row, the alerts row, with the words of the design', () => {
    const { rows } = permissionRows({ notificationsGranted: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBe('alerts');
    expect(rows[0]?.title).toBe('Alerts when a file arrives');
    expect(rows[0]?.sub).toBe('A short banner so you know something came in.');
    expect(ALERTS_TITLE).toBe('Alerts when a file arrives');
    expect(ALERTS_SUB).toBe('A short banner so you know something came in.');
  });

  it('renders the alerts row from the real OS answer', () => {
    expect(permissionRows({ notificationsGranted: true }).rows[0]?.state).toBe('on');
    expect(permissionRows({ notificationsGranted: false }).rows[0]?.state).toBe('off');
    // "Not asked yet" is a first-launch state. It must not read as granted.
    expect(permissionRows({}).rows[0]?.state).toBe('off');
  });

  it('re-asks for real and reports the answer the platform gives back', async () => {
    const answers: boolean[] = [];
    const rows = withNotificationReask({ notificationsGranted: false }, (a) => answers.push(a));
    notify.requestPermission.mockResolvedValueOnce(true);
    rows.find((r) => r.key === 'alerts')?.onPress?.();
    await vi.waitFor(() => expect(answers).toEqual([true]));
    expect(notify.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('reports a rejected ask as a denial and does not throw into the render', async () => {
    const answers: boolean[] = [];
    const rows = withNotificationReask({}, (a) => answers.push(a));
    notify.requestPermission.mockRejectedValueOnce(new Error('no foreground activity'));
    rows.find((r) => r.key === 'alerts')?.onPress?.();
    await vi.waitFor(() => expect(answers).toEqual([false]));
  });
});

