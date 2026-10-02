import React from 'react';
import { AppRegistry } from 'react-native';
import { createUiRuntime } from '@daak/ui';
import { DaakPopoverShell, DaakDashboardShell, reportStartFault } from './src/shells';
// Deep import, NOT the @daak/platform barrel, for the same reason
// src/shells.tsx:1-8 and src/window-host.ts:1-3 already record. That barrel
// re-exports bgsched/clipboard/fspaths/qr/securestore/share, each of which runs
// TurboModuleRegistry.getEnforcing('<name>') at module-eval time, and macOS
// registers only 'Daak', 'DaakSystemShare', 'DaakSystemNotify' and the desktop
// window/tray modules. Importing the barrel would throw before the first
// render. src/engine.ts is the only platform export this app reaches, and it
// touches exactly one native module: 'Daak', which Daak.swift does register.
import { createEngine } from '@daak/platform/src/engine';
import { onDirectShareUrl } from './src/direct-share';
import { attachNotifyEngine, attachNotifyHost, onDesktopNotify } from './src/notify';
import { attachPicker, nativeDesktopPickFiles } from './src/picker';
import { openDashboard } from './src/window-host';

// One engine for the whole process; popover and dashboard share the same engine
// and event stream.
//
// IN-PROCESS, not an IPC client of daakd (D16.10.3). This is the same
// createEngine() @daak/platform builds for mobile, so the two apps cannot drift
// in how they reach the engine. The daemon shape is what this used to be and it
// did not work here: DaemonClientEngine.connect() imports node:net and node:os,
// react-native-macos shims neither, and Metro refused to BUILD the bundle.
// createDesktopEngine and daakSocketPath survive as exported, tested helpers in
// src/engine.ts for the daemon shape Phase 8 may restore, and
// test/macos-inprocess-ffi.spec.ts pins that the running app never reaches them.
//
// createEngine() is SYNCHRONOUS (it wraps the Daak TurboModule), so there is no
// .then() and no connect() rejection to handle.
//
// prime() is still called AFTER start() resolves: a devices() in flight makes
// start() throw and every mode dies before it renders
// (packages/ui/src/headless.ts:40).
const engine = createEngine();

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

// The composer's file picker (NSOpenPanel in RNShare.mm). Attached HERE, above
// both roots, for the same reason as onDirectShareUrl(): the dashboard window is
// created at launch, so a picker attached after registration would race the
// first render.
attachPicker(nativeDesktopPickFiles);

engine.start()
  .then(() => runtime.prime())
  // Visible, not just logged: the shells render against an engine that is not
  // up, so every peer list, transfer and inbox is empty and the tray says
  // "nothing paired" with nothing on screen explaining why.
  .catch((error) => {
    console.warn('daak: engine start failed:', error);
    reportStartFault(error);
  });

// Registration does NOT sit inside the .then(), unlike the daemon shape this
// replaced. There is no connection to fail here, so deferring registration
// would only mean a start() rejection left the process with no window and no
// diagnostic. Registering unconditionally and letting start() report its own
// failure keeps the honest state visible: the shells render against an engine
// that is not up, which is exactly what they would show with no daemon.
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
