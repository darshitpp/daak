import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// On 2026-10-01 the app process started, then died in applicationDidFinish-
// Launching with:
//
//   An uncaught exception was raised
//   Subclasses must implement a valid getBundleURL method
//   FAULT: RCTAppDelegate::bundleURL not implemented
//
// RCTAppDelegate on react-native-macos 0.76 asks the subclass for `bundleURL`,
// and the base implementation RAISES ("Subclasses must implement a valid
// getBundleURL method"). The generated desktop delegate defined only
// `sourceURLForBridge`, so the app could never load a bundle, from Metro or
// from a release .jsbundle. The iOS delegate in this repo already got this
// right and defines both.
//
// BOTH methods are genuinely required, which a reviewer confirmed by reading
// RCTBridge.mm's -setUp and RCTRootViewFactory: they call sourceURLForBridge:,
// and the base RCTAppDelegate raises for that one too. So neither is dead code
// and this test pins the pair, not a replacement.
//
// A crash in a launch path is invisible to every JS suite, so pin the name the
// base class actually calls.
const delegate = readFileSync(
  join(__dirname, '..', 'macos', 'Daak-macOS', 'AppDelegate.mm'),
  'utf8',
);

describe('the macOS app delegate answers the bundle URL the base class asks for', () => {
  it('defines bundleURL, or RCTAppDelegate raises at launch', () => {
    expect(delegate).toMatch(/^-\s*\(NSURL\s*\*\s*\)bundleURL/m);
  });

  it('routes sourceURLForBridge through it instead of duplicating the logic', () => {
    // Two copies of the DEBUG/Release branch drift, and the legacy method is
    // the one that is no longer called at all.
    expect(delegate).toMatch(/return\s+\[self bundleURL\];/);
  });

  it('brings the dashboard back when the Dock icon is clicked', () => {
    // The window is ordered out at launch, so a normal app needs this handler.
    // Without it the new Dock icon and the Cmd-Tab entry do nothing.
    expect(delegate).toMatch(
      /-\s*\(BOOL\)applicationShouldHandleReopen:[\s\S]*?hasVisibleWindows:[\s\S]*?openDashboard/,
    );
  });
});
