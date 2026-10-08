import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from './strip-comments';

// The macOS dashboard window is orderOut at launch by design, and the tray's
// "Open Dashboard" is the only route back in. On 2026-10-04 that route stopped
// working: the tray item was clickable, the click reported success, and no
// window ever appeared.
//
// CLOSED QUESTION: __weak on this ivar. The first hypothesis was that __weak let
// the window die, so openDashboard returned at `window == nil`. A file probe
// inside openDashboard measured the opposite on 2026-10-04: the adopted window
// was non-nil, visible=1 and onscreen=1 right after makeKeyAndOrderFront, with
// a 1280x748 frame. RCTAppDelegate.h also declares @property(strong) window, so
// the delegate owned the window for its whole life. __weak was NOT the cause.
// The strong reference stays as ownership hygiene, because the delegate is the
// only other owner. The record stays here, because the question is expensive to
// re-derive.
//
// A crash test never fires for this defect, and a UI test needs the window to
// exist first, which is the thing that is broken. So the test reads the source,
// which is the house style for native defects here. See macos-app-delegate.spec.ts.
const windowHost = readFileSync(
  join(__dirname, '..', '..', '..', 'modules', 'rn-tray', 'macos', 'RNWindowHost.mm'),
  'utf8',
);

// EVERY assertion below reads the STRIPPED source. The comment blocks in this
// file quote both selector names and all three policy names while explaining
// the bug. A mutation harness measured that an unstripped indexOf landed
// inside the comment text, so both the order assertion and the activation
// assertion passed on the old broken order and on a deleted activation call.
// Stripping first is what makes each assertion read code.
const windowHostCode = stripComments(windowHost);

describe('the dashboard window survives until openDashboard is called', () => {
  it('does not hold the dashboard window weakly', () => {
    // A __weak window dies as soon as the last strong owner releases it, so the
    // owner is pinned instead. NSApplication holds this delegate for the life
    // of the process, and RCTAppDelegate.h line 64 declares the window
    // @property (nonatomic, strong, nonnull), so the delegate already owned it.
    expect(windowHostCode).not.toMatch(/__weak\s+NSWindow\s*\*\s*_dashboard/);
  });

  it('keeps a strong reference to the dashboard window', () => {
    // The lookbehind is the point. Without it this regex also matches the
    // __weak declaration above, so the weakened mutant passes and the test
    // adds nothing over the __weak assertion. The lookbehind refuses the word
    // __weak at any run of spaces, so it only accepts the unprefixed ivar.
    expect(windowHostCode).toMatch(/(?<!__weak\s+)NSWindow\s*\*\s*_dashboard\s*;/);
  });
});

describe('openDashboard still reports a missing window', () => {
  it('keeps the nil guard, because adoption can still fail', () => {
    // The guard is correct and cheap. Removing it would turn a nil window into
    // a silent no-message result instead of a clean return.
    expect(windowHostCode).toMatch(/if\s*\(window\s*==\s*nil\)/);
  });
});

// THE MEASURED CAUSE, 2026-10-04. The whole chain works. The tray click reaches
// JavaScript, JavaScript calls this module, and this method opens the window.
// CoreGraphics reported the window on screen (layer 0, onscreen=1, alpha=1,
// 1280x748). System Events reported zero windows and frontmost=false, because
// the app was never active.
//
// The live process measured NSApplicationActivationPolicyProhibited (value 2) on
// 2026-10-04. Under that policy an app may not create windows and may not be
// activated, so -activateIgnoringOtherApps: is refused and the window stays
// behind every other window. The window was on screen the whole time, so the
// defect looked like a dead menu item.
//
// WHY THE PROCESS SAT ON 2 IS NOT DOCUMENTED. The old Info.plist set
// LSUIElement=1 and did NOT set LSBackgroundOnly. NSRunningApplication.h maps
// LSUIElement=1 to Accessory, so the documented value for the old Info.plist
// was Accessory while the measured value was Prohibited. The disagreement is
// recorded as unknown, so no test asserts a cause.
//
// THE FIX HAS TWO PARTS.
//
// Part one lives in AppDelegate.mm, which sets the policy on the next main-queue
// turn after launch. A clean relaunch after that rebuild measured
// activationPolicy=1.
//
// Part two is the fallback in this method. Measurement showed that the policy
// switch inside openDashboard alone does NOT make the app frontmost: the policy
// on a fresh launch was still 2, the switch did run, and the app still ended up
// frontmost=false. The check below repairs the policy if it reads back as
// Prohibited.
//
// BOTH CALLS ALREADY EXISTED at the old HEAD. -activateIgnoringOtherApps: was
// already called, on the line AFTER makeKeyAndOrderFront. So the line order was
// NOT the defect. The policy was. The order assertion below pins the current
// order so it cannot drift silently, but it does not claim to be the fix, and
// Apple documents no ordering requirement between the two calls.
//
// Regular, not Accessory: this is a NORMAL app. It has a Dock icon, a Cmd-Tab
// entry, and the standard app menu bar, and the menu-bar status item stays
// beside them. The policy repair below only has to move the process OFF
// Prohibited, so Regular is the value it restores.
describe('the dashboard window can come to the front', () => {
  // Scoped to the method body AND stripped. A slice taken at the method
  // signature also carried the ten comment lines that sit below the
  // signature and above the fix. Those lines named both selectors, so an
  // unstripped indexOf read the comment. That was the defect: activate landed
  // at index 392 and orderFront at 440, both inside those comment lines.
  const openDashboardBody = windowHostCode.slice(
    windowHostCode.indexOf('- (void)openDashboard {'),
    windowHostCode.indexOf('- (void)closePopover {'),
  );

  it('exits the Prohibited policy that a launch measured', () => {
    // Prohibited is the policy that makes the window open behind every other
    // app. It may be READ, to detect the broken state, but it must never be the
    // policy the app settles on. Both checks read the stripped slice.
    expect(openDashboardBody).toMatch(
      /setActivationPolicy:\s*NSApplicationActivationPolicyRegular/,
    );
    expect(openDashboardBody).not.toMatch(
      /setActivationPolicy:\s*NSApplicationActivationPolicyProhibited/,
    );
  });

  // MEASURED MUTANT. The two assertions above read the setActivationPolicy line
  // only. Replacing the whole condition with "if (NO) {" leaves that line intact,
  // so both assertions above still pass. A mutation harness measured that on
  // 2026-10-05: the mutant ran 11 tests and 11 passed. So the switch call can be
  // dead code and the suite is green, which is exactly the defect this guard is
  // for. This case pins the CONDITION, so the guard cannot be bypassed.
  it('reads the live policy so the guard cannot be dead code', () => {
    expect(openDashboardBody).toMatch(
      /if\s*\(\s*NSApp\s*\.\s*activationPolicy\s*==\s*NSApplicationActivationPolicyProhibited\s*\)/,
    );
  });

  it('repairs the policy to the normal app shape', () => {
    // The repair must choose Regular. Accessory would undo the normal app shape
    // that this task exists to give the app.
    expect(openDashboardBody).not.toMatch(
      /setActivationPolicy:\s*NSApplicationActivationPolicyAccessory/,
    );
  });

  it('calls the activation selector with the YES argument', () => {
    // Stripping alone does NOT catch a deleted activation call: the nil guard
    // and makeKeyAndOrderFront both survive, so the order assertion still
    // holds. This pins the call itself, receiver and argument together.
    expect(openDashboardBody).toMatch(/\[NSApp activateIgnoringOtherApps:YES\]/);
  });

  it('activates the app before it orders the window front', () => {
    // This pins the current order, NOT the cause. The defect was the policy,
    // and both orders were refused under Prohibited. The assertion exists so a
    // future edit cannot swap the two lines without a failing test to explain
    // itself. Both indexes are computed on the STRIPPED slice, so they read the
    // two real calls.
    const activate = openDashboardBody.indexOf('activateIgnoringOtherApps');
    const orderFront = openDashboardBody.indexOf('makeKeyAndOrderFront');
    expect(activate).toBeGreaterThan(-1);
    expect(orderFront).toBeGreaterThan(-1);
    expect(activate).toBeLessThan(orderFront);
  });
});
