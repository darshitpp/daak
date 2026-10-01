import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

// On 2026-10-01 the macOS app built all the way to the final link and then died:
//
//   _OBJC_CLASS_$_UNUserNotificationCenter
//   _OBJC_CLASS_$_UNNotificationRequest
//   _OBJC_CLASS_$_UNNotificationDefaultActionIdentifier
//
// modules/rn-notify/macos/RNNotify.mm imports <UserNotifications/UserNotifications.h>
// and calls into it, so the pod's own .o carries undefined UN* symbols. The
// podspec declared no frameworks, CocoaPods emitted no -framework flag, and the
// app target never linked UserNotifications. No JS test can see this: it is
// decided at link time, long after every JS suite has passed.
//
// Pods that DO import a system framework rely on CocoaPods inferring it from
// their own module maps, which is why DaakShare and DaakTray never hit this.
// DaakNotify has no module map to read, so it has to say so.
const podspec = join(__dirname, '..', '..', '..', 'modules', 'rn-notify', 'DaakNotify.podspec');

describe('the macOS notify pod links the framework it imports', () => {
  it('declares UserNotifications, or the final link fails on UN* symbols', () => {
    const spec = readFileSync(podspec, 'utf8');
    // A commented-out mention is not a link. The original failure is exactly
    // this line being present but ineffective, so assert on an assignment.
    expect(spec).toMatch(/^\s*s\.frameworks\s*=.*UserNotifications/m);
  });
});
