// Deep import, not the @daak/rn-tray barrel: the barrel's default export is
// NativeDaakTray, whose TurboModuleRegistry.getEnforcing('DaakTray') throws at
// module-eval time when the module is absent. This file is the one place that
// has to tolerate its absence, so it must not evaluate the tray spec.
import { NativeModules } from 'react-native';

// The ObjC class is RNWindowHost, exported as DaakWindowHost. The exported name
// is deliberately singular and host-scoped rather than a bare platform name: a
// module name that reads as belonging to some other OS is how two hosts end up
// fighting over one NativeModules key.
const NativeDaakWindowHost:
  | {
      openDashboard(): Promise<void>;
      closePopover(): Promise<void>;
    }
  | undefined = NativeModules.DaakWindowHost;

export function openDashboard(): Promise<void> {
  return NativeDaakWindowHost?.openDashboard() ?? Promise.resolve();
}

export function closePopover(): Promise<void> {
  return NativeDaakWindowHost?.closePopover() ?? Promise.resolve();
}
