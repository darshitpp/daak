import React from 'react';
import { AppRegistry } from 'react-native';
import { DaakUiApp, createUiRuntime } from '@daak/ui';
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
  // NAME MISMATCH, still open: the generated
  // apps/desktop/macos/Daak-macOS/AppDelegate.mm sets moduleName = "Daak", but
  // only 'DaakPopover' and 'DaakDashboard' are registered below, so neither name
  // matches what the native app asks React Native for. Task 4 owns renaming the
  // native moduleName to 'DaakDashboard'; until then the macOS shell starts and
  // then renders no root. Do not paper over it by renaming the two roots here.
  AppRegistry.registerComponent('DaakPopover', () =>
    function DaakPopoverRoot() {
      return <DaakUiApp mode="popover" engine={engine} runtime={runtime} />;
    });

  AppRegistry.registerComponent('DaakDashboard', () =>
    function DaakDashboardRoot() {
      return <DaakUiApp mode="dashboard" engine={engine} runtime={runtime} />;
    });
}).catch((error) => console.warn('daakd not reachable yet:', error));
