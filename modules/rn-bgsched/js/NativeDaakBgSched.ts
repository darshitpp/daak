import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  /**
   * One-shot platform setup. iOS needs no work here: the BGTaskScheduler
   * handlers are registered by the APP TARGET at launch (see
   * DaakBgLaunch.swift), because iOS launches the process for a BGTask and the
   * TurboModule does not exist until the bridge has booted. Android's half is
   * the periodic WorkManager job.
   */
  configure(): Promise<void>;
  /** iOS BGAppRefreshTaskRequest. No-op on Android, which uses WorkManager. */
  scheduleAppRefresh(): Promise<void>;
  /** iOS BGProcessingTaskRequest. No-op on Android, which uses WorkManager. */
  scheduleProcessing(earliestSeconds: number): Promise<void>;
  /**
   * Android only: raise a low-importance dataSync foreground service so a long
   * transfer is not killed. A no-op resolve on iOS, which has no equivalent.
   */
  startForegroundSync(label: string): Promise<void>;
  stopForegroundSync(): Promise<void>;
  /**
   * Wakes the engine's outbox. NOT a drain: the outbox worker has its own
   * 5s ticker and is poked on every enqueue and on peer presence, so a queued
   * row is delivered on reconnect with nobody asking. See the GAP 1 ruling in
   * the Task 10 report.
   */
  enqueueDrain(): Promise<void>;
  /**
   * Opens the OS battery-optimisation settings. USER-INITIATED: it may only be
   * called from an explicit tap, never on launch.
   */
  requestBatteryExemption(): Promise<void>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('DaakBgSched');
