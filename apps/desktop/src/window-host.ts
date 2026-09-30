// Deep import, not the @daak/rn-tray barrel: the barrel's default export is
// NativeDaakTray, whose TurboModuleRegistry.getEnforcing('DaakTray') throws at
// module-eval time when the module is absent. This file is the one place that
// has to tolerate its absence, so it must not evaluate the tray spec.
import { NativeModules } from 'react-native';

// The ObjC class is RNWindowHost, exported as DaakWindowHost. The exported name
// is deliberately singular and host-scoped rather than a bare platform name: a
// module name that reads as belonging to some other OS is how two hosts end up
// fighting over one NativeModules key.
interface WindowHostModule {
  openDashboard(): Promise<void>;
  closePopover(): Promise<void>;
}

// Read inside each call, not captured at module-eval time. This file is
// imported at the top of apps/desktop/index.js, which evaluates before the
// bridge installs its modules, so a value captured here would be undefined in
// the real app for the whole run. That was harmless while the only callers were
// tray-menu clicks (they run long after start-up); a daak:// link can arrive at
// any moment, including before the first tray click ever happens.
function native(): WindowHostModule | undefined {
  return NativeModules.DaakWindowHost as WindowHostModule | undefined;
}

export function openDashboard(): Promise<void> {
  return native()?.openDashboard() ?? Promise.resolve();
}

export function closePopover(): Promise<void> {
  return native()?.closePopover() ?? Promise.resolve();
}
