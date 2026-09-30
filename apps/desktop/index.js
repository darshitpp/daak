import React from 'react';
import { AppRegistry } from 'react-native';
import { createUiRuntime } from '@daak/ui';
import { DaakPopoverShell, DaakDashboardShell } from './src/shells';
import { createDesktopEngine, daakSocketPath } from './src/engine';
import { onDirectShareUrl } from './src/direct-share';
import { attachNotifyEngine, attachNotifyHost, onDesktopNotify } from './src/notify';
import { openDashboard } from './src/window-host';

// One engine for the whole process; popover and dashboard share the same
// daemon connection and event stream.
//
// prime() is called AFTER start() resolves: the IPC wire carries one request
// at a time, so a devices() in flight makes start() throw and every mode dies
// before it renders (packages/ui/src/headless.ts:40).
createDesktopEngine(daakSocketPath(process.env, process.platform)).then((engine) => {
  const runtime = createUiRuntime(engine);

  // daak://send?deviceId=... routing. Registered HERE, above both roots, because
  // the dashboard window is created at launch and merely orderOut: a link that
  // arrives has to be able to reach a tree that is already mounted.
  onDirectShareUrl();

  // Desktop banners for a received payload, and the ONE action button on them.
  // 'open' is the only INSTALLED action; 'share' and 'show' are in the frozen
  // vocabulary and deliberately withheld (R37, see
  // modules/rn-notify/js/actions.ts) because neither has an implementation, and
  // a button that only foregrounds the app is worse than no button.
  //
  // Registered HERE for the same reason as onDirectShareUrl(): above both roots,
  // and on the ONE engine stream, because that stream also carries pairing and
  // transfer events that the dashboard is already reading.
  //
  // The engine and the window host are INJECTED rather than imported inside
  // src/notify.ts, because that module is loaded by vitest under a react-native
  // stub with no bridge, and it resolves the DaakSystemNotify TurboModule lazily
  // inside onDesktopNotify. Injection is what lets test/notify.spec.ts drive the
  // decision and the subscription without touching a native module.
  attachNotifyEngine(engine);
  attachNotifyHost(openDashboard);
  onDesktopNotify();

  engine.start()
    .then(() => runtime.prime())
    .catch((error) => console.warn('daakd not reachable yet:', error));

  // Registration deliberately sits inside the .then(): with no daemon there is
  // no engine to render, so nothing is registered and the app shows no root.
  // That is fine for now because the daemon is supervised (launchd / systemd /
  // the Win32 service) and the process is launched with it, and because
  // DaemonClientEngine does not reconnect on purpose
  // (packages/core/src/engine/DaemonClient.ts:27). Reconnect and supervision
  // are Phase 8's, not this file's.
  //
  // The native moduleName is 'DaakDashboard' (AppDelegate.mm), which IS the
  // second key registered below, so the shell and the dashboard now agree.
  AppRegistry.registerComponent('DaakPopover', () =>
    function DaakPopoverRoot() {
      return <DaakPopoverShell engine={engine} runtime={runtime} />;
    });

  AppRegistry.registerComponent('DaakDashboard', () =>
    function DaakDashboardRoot() {
      return <DaakDashboardShell engine={engine} runtime={runtime} />;
    });
}).catch((error) => console.warn('daakd not reachable yet:', error));
