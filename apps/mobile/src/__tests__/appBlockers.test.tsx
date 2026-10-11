import React from 'react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { mockPlatformHost } from '../testPlatformMock';
import App from '../App';

/**
 * THE PHONE HAS NO PRIVATE COPY OF THE BLOCKING LOGIC (R43c).
 *
 * packages/ui/src/state/useBlockers.ts is the ONE implementation of the two
 * prototype blocking screens, and apps/desktop/src/shells.tsx already calls it
 * at both of its roots. apps/mobile/src/App.tsx carried its own inline copy of
 * the same rule, so the codebase held two implementations of one decision and
 * the phone and the desktop could disagree about when the screen opens.
 *
 * WHY A SOURCE PIN, AND WHY THE COMMENTS ARE STRIPPED. The reachability rule is
 * a decision made inside a component that mounts an engine, so there is no
 * barrel to import and no prop to assert on. The house style for that shape is
 * apps/desktop/test/blocking-screens.spec.ts, which pins shells.tsx the same
 * way, and it strips comments first for one reason: this file and App.tsx both
 * explain these identifiers at length, so an unstripped assertion would be
 * satisfied by prose alone. The scanner below is the same algorithm as
 * apps/desktop/test/strip-comments.ts, restated here because that file belongs
 * to the desktop tree and this test may not read across the project root.
 *
 * HONEST LIMIT: a source pin cannot see whether the hook returns the right
 * node. packages/ui/src/state/useBlockers.test.tsx mounts the hook and asserts
 * on the real rendered screens, and the behavioural case at the end of this
 * file mounts App itself, so the two together cover the whole route.
 */

/**
 * Source with every comment removed. Written as a scanner and not as a regex
 * with replacements, because a string literal holding a quote-plus-comment
 * sequence would desync a naive strip, and because the one thing this must not
 * do is throw away a line of code.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  // The quote a string literal is currently inside, or null.
  let quote: "'" | '"' | '`' | null = null;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (quote !== null) {
      if (source[i] === '\\') {
        out += two;
        i += 2;
        continue;
      }
      if (source[i] === quote) quote = null;
      out += source[i];
      i += 1;
      continue;
    }
    if (source[i] === "'" || source[i] === '"' || source[i] === '`') {
      quote = source[i] as "'" | '"' | '`';
      out += source[i];
      i += 1;
      continue;
    }
    if (two === '//') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (two === '/*') {
      i += 2;
      while (i < source.length && source.slice(i, i + 2) !== '*/') i += 1;
      i += 2;
      continue;
    }
    out += source[i];
    i += 1;
  }
  return out;
}

const appCode = stripComments(readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8'));

// The Send tab's picker is INJECTED, and the real barrel pulls the `Daak`
// TurboModule through @daak/core at module-eval time, which throws under Jest
// with no bridge. App now imports the blocking hook from @daak/ui, and the hook
// takes a DaakEngine as its first argument, so the mock engine below is what the
// phone is asked about.
jest.mock('@daak/platform', () => mockPlatformHost());
jest.mock('../BackgroundSyncNotice', () => ({
  BackgroundSyncNotice: () => null,
}));
jest.mock('../PairingFlow', () => ({
  PairingFlow: () => null,
}));

// The real bootstrap reaches for the `Daak` TurboModule, which does not exist
// under Jest. Swap in the in-memory engine.
jest.mock('../bootstrap', () => ({
  engine: jest.requireActual('@daak/ui').fakeEngine(),
  startEngine: async () => {},
  startEngineOnce: jest.fn(async () => {}),
  drainInbound: jest.fn(async () => {}),
  wireNotificationActions: jest.fn(() => () => {}),
  sendIntentItems: jest.fn(async () => {}),
  onIncompatiblePeer: jest.fn(() => () => {}),
  postReceiveNotifications: jest.fn(async () => true),
  notificationGrant: jest.fn(() => true),
  recordNotificationGrant: jest.fn(),
}));

const { engine } = jest.requireMock('../bootstrap');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('the phone reads its blocking facts from the shared hook', () => {
  // The hook is the ONE implementation. A phone that kept its own copy of the
  // reachability rule beside it would hold two truths, and the two could drift.
  it('calls useBlockers, and imports it from the shared package', () => {
    expect(appCode).toMatch(/useBlockers\s*\(/);
    expect(appCode).toMatch(/import\s*\{[^}]*\buseBlockers\b[^}]*\}\s*from\s*'@daak\/ui'/);
  });

  // The hook takes the ALREADY REDUCED incompatible list rather than
  // subscribing to the engine itself, so a second engine.on cannot double an
  // event (R43a). The host keeps its one existing subscription, so the value
  // handed to the hook must be that subscription's own state.
  it('hands the hook the incompatible peers its own subscription holds', () => {
    expect(appCode).toMatch(
      /useBlockers\(\s*engine\s*,\s*incompatible\s*,\s*BLOCKER_HOST\s*\)/,
    );
    expect(appCode).toMatch(
      /const\s*\[\s*incompatible\s*,\s*setIncompatible\s*\]\s*=\s*useState<\s*IncompatiblePeer\[\]\s*>\s*\(/,
    );
  });

  // All four values. AppShell treats `alert` and `alertRouteToken` together as
  // the whole decision, so either half alone leaves the prototype screen
  // unreachable; the settings token is what makes "Open Settings" land, and
  // onCheckConnection is the only thing that opens the can't-reach screen.
  it('forwards the alert, both route tokens and the connection check', () => {
    expect(appCode).toMatch(/\balert\s*=\s*\{?\s*(blockers\s*\.\s*)?alert\b/);
    expect(appCode).toMatch(
      /\balertRouteToken\s*=\s*\{?\s*(blockers\s*\.\s*)?alertRouteToken\b/,
    );
    expect(appCode).toMatch(
      /\bsettingsRouteToken\s*=\s*\{?\s*(blockers\s*\.\s*)?settingsRouteToken\b/,
    );
    expect(appCode).toMatch(
      /\bonCheckConnection\s*=\s*\{?\s*(blockers\s*\.\s*)?onCheckConnection\b/,
    );
  });

  // The negative half. Without it, a host that kept its own useState copies
  // beside the hook passes every case above and still owns two truths. Every
  // name below was a private declaration in App.tsx before this task.
  it('keeps no private copy of the update token, the cannot-reach reason or the queue', () => {
    expect(appCode).not.toMatch(/setUpdateToken/);
    expect(appCode).not.toMatch(/setNoDevices/);
    expect(appCode).not.toMatch(/setSettingsToken/);
    expect(appCode).not.toMatch(/setRetrying/);
    expect(appCode).not.toMatch(/setQueued/);
  });

  // The three callbacks the hook now owns, and the alert node they built.
  // Each was a character-for-character restatement of the hook's own body.
  it('declares no reachability check, no pending outbox and no alert slot of its own', () => {
    expect(appCode).not.toMatch(/\bcheckReachability\b/);
    expect(appCode).not.toMatch(/\bpendingOutbox\b/);
    expect(appCode).not.toMatch(/\bopenReachabilityCheck\b/);
    expect(appCode).not.toMatch(/\bretryReachability\b/);
    expect(appCode).not.toMatch(/\bopenSettingsFromAlert\b/);
    expect(appCode).not.toMatch(/\balertSlot\b/);
    // And the two screens themselves are no longer built here: the hook
    // creates both nodes.
    expect(appCode).not.toMatch(/\bUpdateRequiredScreen\b/);
    expect(appCode).not.toMatch(/\bCantReachScreen\b/);
  });

  // A check on MOUNT is the ruling R43b turned down: Daak answers "nobody" on
  // a healthy LAN whenever the other device is asleep, so a mount-time check
  // puts a wall in front of a working app. The hook owns that decision, so the
  // host must not reintroduce it with an effect of its own.
  it('runs no reachability check from an effect in App', () => {
    expect(appCode).not.toMatch(/useEffect\s*\([^)]*onCheckConnection/);
  });

  // The ONE engine subscription the phone already had must stay the only one.
  // A second engine.on in app code is the defect that doubles an event, so the
  // hook taking the engine must not drag a subscription along behind it.
  it('opens no second engine subscription', () => {
    expect(appCode).not.toMatch(/engine\s*\.\s*on\s*\(/);
  });
});

/**
 * The behaviour, so the suite does not rest on source shape alone.
 *
 * This drives the REAL App with an engine whose devices() resolves empty,
 * taps the Devices tab affordance the prototype puts there, and asserts the
 * real CantReachScreen appears. It fails if the phone stops forwarding the
 * hook's connection check, and it fails if the hook's alert is not wired to
 * AppShell.
 */
describe('the connection check opens the cannot-reach screen on the phone', () => {
  it('shows No connection after a check that finds nobody', async () => {
    // Empty on purpose: discovery found nobody. This is the honest answer that
    // must produce the screen.
    jest.spyOn(engine, 'devices').mockResolvedValue([]);
    render(<App />);

    // The Devices tab, then the affordance the prototype puts there. The
    // button is a real Btn, so its testID is its accessibility label.
    fireEvent.press(await screen.findByTestId('tab-devices'));
    expect(screen.queryByText("Daak can't reach any devices")).toBeNull();
    fireEvent.press(screen.getByTestId('devices-check-connection'));

    await waitFor(() =>
      expect(screen.getByText("Daak can't reach any devices")).toBeTruthy(),
    );
    // The real screen, not a lookalike: it carries its own testID.
    expect(screen.getByTestId('screen-cant-reach')).toBeTruthy();
    await act(async () => {});
  });

  // The screen must NOT appear before the user asks. Daak answers "nobody" on
  // a healthy LAN whenever the other device is asleep, so a mount-time check
  // would put a wall in front of a working app. This is the control for the
  // case above.
  it('shows nothing before the user asks for a check', async () => {
    jest.spyOn(engine, 'devices').mockResolvedValue([]);
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('tab-devices')).toBeTruthy());
    await act(async () => {});
    expect(screen.queryByTestId('screen-cant-reach')).toBeNull();
  });
});
