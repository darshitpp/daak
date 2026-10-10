import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from './strip-comments';

/**
 * THE TWO BLOCKING SCREENS REACH THE DESKTOP.
 *
 * The macOS prototype has 13 screens. Before this file the desktop rendered 11,
 * because neither Call Reach nor Update Required could appear on macOS: shells.tsx
 * passed no `alert` and no `alertRouteToken` to DaakUiApp at either of its two
 * call sites, and AppShell treats the pair as the whole decision. `alert` with no
 * token renders nothing at all, so the two screens existed in packages/ui and
 * were unreachable on the platform that owns the prototype.
 *
 * WHY SOURCE PINS: shells.tsx is the host shell, and the values it forwards are
 * React nodes built by a hook inside it. Reading the sources is the house style
 * for desktop defects that live behind a native bridge; quit-app.spec.ts and
 * picker.spec.ts do the same. The source is STRIPPED, so the prose above the
 * rule can never satisfy a case -- the file header above shells.tsx explains at
 * length why the tray lives where it does, and an unstripped pin would be
 * satisfied by the comment alone.
 *
 * HONEST LIMIT: a source pin cannot see whether the hook itself returns the
 * right node. packages/ui/src/state/useBlockers.test.tsx mounts the hook and
 * asserts on the real rendered screens, so the pair of files covers the whole
 * route: this one proves the desktop forwards, that one proves what it forwards.
 */

const shellsCode = stripComments(
  readFileSync(join(__dirname, '..', 'src', 'shells.tsx'), 'utf8'),
);

/** The BODY of one exported function, brace balanced. quit-app.spec.ts records
 * why a whole-file read is too loose: any other function's own copy of a prop
 * name would satisfy a case that means THIS function. */
function functionBody(code: string, signature: string): string {
  const at = code.indexOf(signature);
  expect(at).toBeGreaterThan(-1);
  // The body opens at the brace that CLOSES the parameter list, not at the
  // first brace after the signature: every shell here destructures
  // { engine, runtime }, so scanning from the first brace returns that
  // destructuring pattern as if it were the whole body. Measured against the
  // ') {' that ends the parameters.
  const bodyMarker = code.indexOf(') {', at + signature.length - 1);
  expect(bodyMarker).toBeGreaterThan(at);
  const open = bodyMarker + 2;
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}' && --depth === 0) return code.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces in ${signature}`);
}

// Both roots, because the popover is a whole window a user sees and the
// dashboard is the window they spend the day in. A screen that only appears in
// one of them is still a missing screen.
const popoverBody = functionBody(shellsCode, 'export function DaakPopoverShell(');
const dashboardBody = functionBody(shellsCode, 'export function DaakDashboardShell(');

describe('both desktop shells pass the blocking facts to DaakUiApp', () => {
  for (const [name, body] of [['popover', popoverBody], ['dashboard', dashboardBody]] as const) {
    // The screen itself, and the token that opens it. AppShell renders the alert
    // only when BOTH are present, so either half alone leaves the prototype
    // screen unreachable and this case must not accept a partial fix.
    //
    // The value is either a bare name the shell destructured from the hook, or
    // `blockers.<prop>` off the object the hook returned. Both are the same
    // forward; the pattern accepts each so the rule is about the VALUE, not
    // about which destructuring style this shell happened to choose.
    it(`gives the ${name} shell an alert and an alert route token`, () => {
      expect(body).toMatch(/\balert\s*=\s*\{?\s*(blockers\s*\.\s*)?alert\b/);
      expect(body).toMatch(/\balertRouteToken\s*=\s*\{?\s*(blockers\s*\.\s*)?alertRouteToken\b/);
    });

    // "Open Settings" on a blocking screen must LAND somewhere. A button that
    // only dismisses the screen it is on is a dead button, because the user is
    // told to go somewhere and stays where they were.
    it(`gives the ${name} shell the settings route token`, () => {
      expect(body).toMatch(
        /\bsettingsRouteToken\s*=\s*\{?\s*(blockers\s*\.\s*)?settingsRouteToken\b/,
      );
    });

    // The Devices tab and Settings both offer "...isn't showing? See what to
    // check". It is the ONLY thing that opens Call Reach, and it must be the
    // same function the hook returned.
    it(`gives the ${name} shell the on-demand connection check`, () => {
      expect(body).toMatch(
        /\bonCheckConnection\s*=\s*\{?\s*(blockers\s*\.\s*)?onCheckConnection\b/,
      );
    });
  }

  // The hook is the ONE implementation. Two hosts each keeping their own copy
  // of the reachability logic is how the desktop and the phone came to disagree
  // about when the screen opens.
  it('reads the blocking facts from the shared hook, not from its own state', () => {
    expect(shellsCode).toMatch(/\buseBlockers\s*\(/);
    expect(shellsCode).toMatch(/import\s*\{[^}]*\buseBlockers\b[^}]*\}\s*from\s*'@daak\/ui'/);
  });

  // The hook needs the peer list the daemon already reduced. Reading it off the
  // SAME UiState the shell already subscribes to is what keeps this a second
  // VARIABLE rather than a second engine subscription (R43a). A bare
  // runtime.getState().incompatible read inside useBlockers(...) is not enough:
  // it is a snapshot, so a peer that arrives later would never reach the hook.
  it('hands the hook the incompatible peers the store already holds', () => {
    // The reduced list comes from a SUBSCRIBED snapshot, not from a one-off read.
    expect(shellsCode).toMatch(/useSyncExternalStore\(/);
    expect(shellsCode).toMatch(/runtime\s*\.\s*getState\s*\(\s*\)\s*\.\s*incompatible\b/);
    // And each shell hands a value named incompatible to the hook, as the
    // second argument. Either spelling is fine: a shell that binds the snapshot
    // to a local name and passes the name, and a shell that inlines the call,
    // are the same decision. The names below keep the two shells readable.
    expect(shellsCode).toMatch(
      /useBlockers\(\s*engine\s*,\s*(incompatible\s*[,)]|useIncompatible\s*\(\s*runtime\s*\))/,
    );
    // The value must be bound to a name in each shell body, so the second
    // argument is not an unrelated expression that happens to compile.
    for (const body of [popoverBody, dashboardBody]) {
      expect(body).toMatch(/const\s+incompatible\s*=\s*useIncompatible\s*\(\s*runtime\s*\)/);
      expect(body).toMatch(/useBlockers\(\s*engine\s*,\s*incompatible\s*,\s*BLOCKER_HOST\s*\)/);
    }
  });

  // The device noun reaches the copy through one module constant. A shell that
  // forgets it shows "This device is on this Wi-Fi" on a Mac.
  it('gives the hook a host object with the noun Mac', () => {
    expect(shellsCode).toMatch(/const\s+BLOCKER_HOST\b[^=]*=\s*\{[^}]*deviceNoun:\s*'Mac'/);
  });

  // The negative half. Without it, a host that kept its own useState copies
  // beside the hook would pass every case above and still own two truths.
  it('keeps no private copy of the update token or the cannot-reach reason', () => {
    expect(shellsCode).not.toMatch(/setUpdateToken/);
    expect(shellsCode).not.toMatch(/setNoDevices/);
  });

  // A check on MOUNT is the ruling R43b turned down: Daak answers "nobody" on a
  // healthy LAN whenever the other device is asleep, so a mount-time check puts
  // a wall in front of a working app. The hook owns that decision, so the shell
  // must not reintroduce it with an effect of its own.
  it('runs no reachability check from an effect in the shell', () => {
    expect(shellsCode).not.toMatch(/useEffect\s*\([^)]*onCheckConnection/);
  });
});
