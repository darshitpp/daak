import NativeDaakBgSched from '@daak/rn-bgsched';

/**
 * The two BGTaskScheduler identifiers, duplicated verbatim in
 * apps/mobile/ios/Daak/Info.plist and in DaakBgLaunch.swift because none of
 * those three can import each other. A rename on one side is SILENT: iOS
 * refuses to submit a request for an identifier it does not permit and never
 * runs it. Pinned equal by apps/mobile/src/__tests__/backgroundExec.test.ts.
 */
export const DAAK_BG_IDENTIFIERS = [
  'dev.darshit.daak.refresh',
  'dev.darshit.daak.processing',
] as const;

/** The earliest iOS will consider a processing task. Also the Android period. */
export const DAAK_BG_INTERVAL_SECONDS = 15 * 60;

/**
 * Registers background execution and books the first slot.
 *
 * Never throws. A rejected configure or schedule costs a background slot, and a
 * background slot costs LATENCY on a transfer the outbox already retries on its
 * own ticker -- so throwing here would take down app startup for a detail the
 * user never sees. Same reasoning as R36's notification permission.
 */
export async function initBackgroundSync(): Promise<void> {
  await NativeDaakBgSched.configure().catch(() => {});
  await NativeDaakBgSched.scheduleAppRefresh().catch(() => {});
  await NativeDaakBgSched.scheduleProcessing(DAAK_BG_INTERVAL_SECONDS).catch(() => {});
}

/**
 * Android: hold the process up with a low-importance dataSync notification
 * while a transfer is in flight, so a long send is not killed mid-file. A
 * no-op on iOS, which has no equivalent.
 *
 * This is NOT a send. Nothing here reaches the transport or the crypto: the
 * engine's outbox owns every Daak-to-Daak transfer, and this only keeps the
 * process alive while the outbox does that work.
 */
export function startTransferForeground(label: string): Promise<void> {
  return NativeDaakBgSched.startForegroundSync(label);
}

export function stopTransferForeground(): Promise<void> {
  return NativeDaakBgSched.stopForegroundSync();
}

/**
 * Asks the platform to poke the outbox: a one-shot WorkManager job on Android,
 * and a no-op on iOS (where the wake path is the launch-time BGTask handler
 * and the outbox's own ticker already runs).
 *
 * This is a WAKE, not a drain. There is no drain entry point on the engine and
 * none is added here -- see the GAP 1 ruling in the Task 10 report.
 */
export function enqueueDrain(): Promise<void> {
  return NativeDaakBgSched.enqueueDrain();
}

/**
 * Opens the OS battery-optimisation settings.
 *
 * USER-INITIATED BY CONTRACT. This navigates away from the app to a system
 * screen, so it may only ever be reached from an explicit tap, never from an
 * effect or from startup. The pin that holds that lives in
 * apps/mobile/src/__tests__/backgroundWiring.test.tsx and
 * backgroundExec.test.ts (no useEffect in the component that calls it).
 */
export function requestBatteryExemption(): Promise<void> {
  return NativeDaakBgSched.requestBatteryExemption();
}
