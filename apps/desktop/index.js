import React from 'react';
import { AppRegistry } from 'react-native';
import { createUiRuntime } from '@daak/ui';
import { DaakPopoverShell, DaakDashboardShell } from './src/shells';
import { createDesktopEngine, daakSocketPath } from './src/engine';

// One engine for the whole process; popover and dashboard share the same
// daemon connection and event stream.
//
// prime() is called AFTER start() resolves: the IPC wire carries one request
// at a time, so a devices() in flight makes start() throw and every mode dies
// before it renders (packages/ui/src/headless.ts:40).
createDesktopEngine(daakSocketPath(process.env, process.platform)).then((engine) => {
  const runtime = createUiRuntime(engine);
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
