import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@daak/rn-bgsched', () => ({
  default: {
    configure: vi.fn(async () => {}),
    scheduleAppRefresh: vi.fn(async () => {}),
    scheduleProcessing: vi.fn(async () => {}),
    startForegroundSync: vi.fn(async () => {}),
    stopForegroundSync: vi.fn(async () => {}),
    enqueueDrain: vi.fn(async () => {}),
    requestBatteryExemption: vi.fn(async () => {}),
    addListener: vi.fn(),
    removeListeners: vi.fn(),
  },
}));

import NativeDaakBgSched from '@daak/rn-bgsched';
import {
  DAAK_BG_IDENTIFIERS,
  enqueueDrain,
  initBackgroundSync,
  requestBatteryExemption,
  startTransferForeground,
  stopTransferForeground,
} from './bgsched';

const native = vi.mocked(NativeDaakBgSched);

beforeEach(() => {
  vi.clearAllMocks();
  native.configure.mockResolvedValue(undefined);
  native.scheduleAppRefresh.mockResolvedValue(undefined);
  native.scheduleProcessing.mockResolvedValue(undefined);
  native.startForegroundSync.mockResolvedValue(undefined);
  native.stopForegroundSync.mockResolvedValue(undefined);
  native.enqueueDrain.mockResolvedValue(undefined);
  native.requestBatteryExemption.mockResolvedValue(undefined);
});

describe('DAAK_BG_IDENTIFIERS', () => {
  // These two strings are also hardcoded in Info.plist and in the app-target
  // Swift that registers the launch handlers (neither can import this module).
  // A rename on one side is SILENT: iOS submits a task for an identifier that
  // is not in BGTaskSchedulerPermittedIdentifiers and never runs it.
  it('are the two ids the platform requires, exactly', () => {
    expect(DAAK_BG_IDENTIFIERS).toEqual([
      'dev.darshit.daak.refresh',
      'dev.darshit.daak.processing',
    ]);
  });
});

describe('initBackgroundSync', () => {
  it('configures and schedules both iOS task kinds', async () => {
    await initBackgroundSync();
    expect(native.configure).toHaveBeenCalled();
    expect(native.scheduleAppRefresh).toHaveBeenCalled();
    expect(native.scheduleProcessing).toHaveBeenCalledWith(15 * 60);
  });

  // A rejected schedule must not take down app startup: the inbox is the
  // source of truth, so a lost background slot costs latency, never a payload.
  it('swallows a rejecting configure or schedule', async () => {
    native.scheduleProcessing.mockRejectedValue(new Error('E_BG'));
    await expect(initBackgroundSync()).resolves.toBeUndefined();
  });
});

describe('the foreground / drain / battery affordances', () => {
  it('passes the label through to the native service', async () => {
    await startTransferForeground('Sending with Daak');
    expect(native.startForegroundSync).toHaveBeenCalledWith('Sending with Daak');
  });

  it('stops the foreground service', async () => {
    await stopTransferForeground();
    expect(native.stopForegroundSync).toHaveBeenCalled();
  });

  it('enqueues a drain', async () => {
    await enqueueDrain();
    expect(native.enqueueDrain).toHaveBeenCalled();
  });

  // requestBatteryExemption opens SYSTEM settings, so it may only be reached
  // from an explicit tap. Nothing here calls it on purpose; the pin that
  // enforces the tap lives in the mobile suite.
  it('opens the battery-optimisation settings', async () => {
    await requestBatteryExemption();
    expect(native.requestBatteryExemption).toHaveBeenCalled();
  });
});
