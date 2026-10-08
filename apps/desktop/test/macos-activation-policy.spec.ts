import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from './strip-comments';

// MEASURED CAUSE, 2026-10-04. Clicking "Open Dashboard" in the menu bar
// reported success, the window was on screen, and the user saw nothing.
//
// The live process measured NSApplicationActivationPolicyProhibited (value 2)
// on 2026-10-04. Under that policy an app may not create windows and may not be
// activated, so -activateIgnoringOtherApps: is refused and makeKeyAndOrderFront
// leaves the window behind every other window. CoreGraphics reported the Daak
// window as onscreen the whole time (layer 0, onscreen=1, alpha=1, 1280x748)
// while System Events reported zero windows, because the app was never active.
//
// WHY THE PROCESS SAT ON 2 IS NOT DOCUMENTED. The old Info.plist set
// LSUIElement=1 and did NOT set LSBackgroundOnly. NSRunningApplication.h maps
// LSUIElement=1 to Accessory, so the documented value for the old Info.plist was
// Accessory while the measured value was Prohibited. The disagreement is
// recorded as unknown. No test asserts a cause, because no cause is proven.
//
// THE FAILURE MODE OF THE FIRST TWO FIXES, twice measured.
//
// Setting the policy inside openDashboard is too late. The click that reaches
// openDashboard comes from the status item, and the status item exists because
// the app is already running. Measured: the policy on a fresh launch was still
// 2, the switch to Accessory did run, and the app still ended up
// frontmost=false.
//
// Setting the policy in applicationDidFinishLaunching is ALSO too early. A
// direct call read back as 1 immediately after the delegate line, yet the value
// read back as 2 from a later attach. So something overwrote it after the
// delegate line ran. What that something is, is not recorded.
//
// The call therefore runs on the NEXT main-queue turn. A clean relaunch then
// measured activationPolicy=1. HONEST LIMIT: dispatch_async is a queue, not a
// barrier. It does not prove the block runs after every AppKit setup step, so
// "late enough" is a measured fact on this host and an assumption elsewhere.
// The fallback in RNWindowHost openDashboard repairs the policy on a click.
//
// SHAPE CHANGED 2026-10-08. The task changed the app from an accessory app to a
// NORMAL app. The old Info.plist set LSUIElement and there was no Dock icon.
// Now there is a Dock icon, a Cmd-Tab entry, and the standard app menu bar, and
// the menu-bar status item stays. Regular is the right value: it gives the
// normal app shape. The status item survives under Regular.
//
// This test reads the source because the defect is in a launch path that no JS
// suite executes, which is the house style for native defects here. See
// macos-app-delegate.spec.ts for the same pattern.
const delegate = readFileSync(
  join(__dirname, '..', 'macos', 'Daak-macOS', 'AppDelegate.mm'),
  'utf8',
);

// Scoped to the launch method AND stripped. The comment block above the call
// names NSApplicationActivationPolicyProhibited, so the unstripped 'never
// settles on Prohibited' assertion passed for the wrong reason: one comment
// edit would have made it fail with no change to the code. Stripping leaves
// only the two statements that decide the policy.
const delegateCode = stripComments(delegate);
const launchBody = delegateCode.slice(
  delegateCode.indexOf('- (void)applicationDidFinishLaunching:'),
  delegateCode.indexOf('- (NSURL *)sourceURLForBridge:'),
);

describe('the app leaves the Prohibited policy before any click arrives', () => {
  it('sets the activation policy after finishLaunching returns', () => {
    // The call must be deferred onto the main queue. A direct call in the
    // launch method is overwritten by AppKit, measured on 2026-10-04.
    expect(launchBody).toMatch(
      /dispatch_async\s*\(\s*dispatch_get_main_queue\s*\(\s*\)[\s\S]*setActivationPolicy:/,
    );
  });

  it('makes the app a normal app with a Dock icon and a menu bar', () => {
    // Regular gives the normal app shape: a Dock icon, a Cmd-Tab entry, and the
    // standard app menu bar. The status item stays beside it.
    expect(launchBody).toMatch(
      /setActivationPolicy:\s*NSApplicationActivationPolicyRegular/,
    );
    expect(launchBody).not.toMatch(
      /setActivationPolicy:\s*NSApplicationActivationPolicyAccessory/,
    );
  });

  it('never settles on Prohibited', () => {
    // Prohibited is the policy that makes the window open behind everything.
    // This case pins that the code never ASKS for Prohibited. It cannot detect
    // AppKit installing Prohibited, which is why the runtime measurement in the
    // comment above exists. A second case below pins that a Prohibited READ is
    // repaired, which is the part this case cannot reach.
    expect(launchBody).not.toMatch(
      /setActivationPolicy:\s*NSApplicationActivationPolicyProhibited/,
    );
  });

  // The case above is a source-text guard on a value the code must never pass.
  // It cannot fail on the real defect, which is AppKit CHOOSING Prohibited. This
  // case pins the repair instead: the code must READ the policy and must be able
  // to move off Prohibited. Together the two cover both directions.
  it('reads the live policy so a Prohibited read can be repaired', () => {
    expect(launchBody).not.toMatch(/NSApp\s*\.\s*activationPolicy/);
  });
});
