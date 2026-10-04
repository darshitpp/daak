import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Why this cannot be a JS test: the thing that broke is native. On 2026-10-04
// an Android emulator was served the DESKTOP bundle by a leftover desktop
// packager still listening on :8081, and it RedBoxed on
// TurboModuleRegistry.getEnforcing('DaakSystemNotify') -- a desktop module name
// that Android never registers. The error named a TurboModule, so it read like
// a native defect, but the port was the whole bug: apps/desktop and
// apps/mobile BOTH defaulted to Metro's 8081.
//
// ONE number, written once. The npm scripts in package.json are the only place
// a port literal is written; everything below either derives from them or is
// asserted equal to them. This file must never introduce a second copy of the
// digits, or it becomes the stale one.
const pkg = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
) as { scripts: Record<string, string> };

const delegate = readFileSync(
  join(__dirname, '..', 'macos', 'Daak-macOS', 'AppDelegate.mm'),
  'utf8',
);

// Comments must not be able to satisfy a source pin, and the stripping is done
// in TWO layers because either layer alone leaks (every hole below was found by
// mutating this very file, and every one of them read GREEN before it was fixed):
//
//   Layer 1 -- block comments as SPANS, then line comments. A line-anchored
//   filter (`/^\s*(\/\/|\/\*|\*)/`) was the first version here and it was
//   wrong twice over: it never tracked that a block comment was OPEN, so every
//   interior line survived, and a `provider.jsLocation = @"localhost:8082";`
//   parked inside a /* ... */ block read as the code while the code beside it
//   said 8083. Removing whole spans first is what closes that.
//
//   Layer 2 -- scope to the bundleURL body. Belt and braces: it bounds the
//   search to the one method that owns the port, so text elsewhere in the file
//   cannot stand in for it. This is the house technique from picker.spec.ts
//   (see componentSource there), which pairs the span strip with a
//   brace-balanced slice for exactly this reason.
//
// Layer 2 alone was NOT enough, which is what rounds 2-4 each proved. A slice
// only bounds the search; it does not stop the search from reading the WRONG
// method (a dead `#if 0` copy ahead of the live one) or from ignoring a write
// OUTSIDE the slice (`sourceURLForBridge` ran first and won, and the nil guard
// then PRESERVED it). Hence layer 3 below, which is a whole-file policy.
//
// Known accepted cost: a `//` inside an ObjC string literal is over-stripped.
// There is none in this delegate, and over-stripping yields a RED test, which
// is the safe direction to be wrong in.
const stripComments = (source: string): string => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  // Trailing `//` counts too. A whole-line-anchored filter (`/^\s*\/\/.*$/gm`)
  // was the version here through round 3 and review finding 3 walked straight
  // through it: a decoy parked after real code on the same line survived and
  // won the first-match. Stripping from the delimiter to end of line closes it.
  .replace(/\/\/.*$/gm, '');

// Brace-balanced slice of one method, from the `{` that opens its BODY. The
// signature's own braces would close immediately, so balance starts at the body.
const methodBody = (source: string, signature: string): string => {
  const at = source.indexOf(signature);
  expect(at).toBeGreaterThan(-1);
  const bodyAt = source.indexOf('{', at + signature.length - 1);
  let depth = 0;
  for (let i = bodyAt; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && --depth === 0) return source.slice(bodyAt, i + 1);
  }
  throw new Error(`unbalanced braces in ${signature}`);
};

// Comments already gone. Two scopes are needed, and the distinction is the
// whole point of this pin: the SLICE says "this is the port the live method
// writes", the WHOLE FILE says "nothing else in this delegate can write it".
const delegateCode = stripComments(delegate);
const bundleURLBody = methodBody(delegateCode, '- (NSURL *)bundleURL');

// The message send a `return` returns, brackets INCLUDED and balanced.
//
// `return\s+\[([^\]]*)\];` is the obvious parse and it is wrong for this
// delegate: the nested instance form `[[RCTBundleURLProvider sharedSettings]
// jsBundleURLForBundleRoot:@"index"]` closes its INNER bracket first, so a
// character-class capture stops at the singleton accessor and leaves the
// selector outside the match. Reading the return that way made this file fail
// on its own source, which is the BLOCKER-3 shape of bug in a new place -- so
// the bracket walk below is the same technique as methodBody, for the same
// reason: balance, not a character class.
const messageSend = (source: string): string | undefined => {
  const at = source.match(/\breturn\s*\[/);
  if (!at || at.index === undefined) return undefined;
  let depth = 0;
  const open = source.indexOf('[', at.index);
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '[') depth += 1;
    else if (source[i] === ']' && --depth === 0) return source.slice(open, i + 1);
  }
  return undefined;
};

// A write to jsLocation anywhere in the delegate, on ANY receiver and in ANY of
// the three legal spellings, captured with its right-hand side.
//
// Three patterns, not one, because Objective-C has three spellings for a
// property write and each reaches the same storage. Verified against the real
// react-native-macos in node_modules: RCTBundleURLProvider.h:103 declares
// `@property (nonatomic, copy, nullable) NSString *jsLocation;`, and
// RCTBundleURLProvider.mm:423 implements `- (void)setJsLocation:` by writing the
// NSUserDefaults key RCT_jsLocation. So `[provider setJsLocation:...]` is real,
// compiler-synthesised, idiomatic API and the LAST writer wins.
//
// This blindness was a real hole, not a hypothetical: a single added line
//   [provider setJsLocation:@"localhost:8081"];
// after the guard reproduced the ORIGINAL bug (desktop back on the port mobile
// owns) with the whole suite green, because the old dot-only token matched
// nothing on that line. A pin cannot claim to cover "any receiver" while
// matching one of two spellings, so all three are counted here.
//
// The THIRD spelling is key-value coding, added in round 6 after the reviewer
// found it GREEN: `[provider setValue:@"localhost:8081" forKey:@"jsLocation"]`.
// RCTBundleURLProvider adds no `setValue:forKey:` override (grepped in
// node_modules), so KVC resolves the key to the very same `setJsLocation:`, and
// one added line reproduced the ORIGINAL 8081 collision with all nine
// assertions green. It is plain NSObject API, and the key string IS the property
// name, which the public header prints at RCTBundleURLProvider.h:103 -- so a
// developer writing a generic settings layer learns the key from the API they
// are already using, with no knowledge of React Native internals at all. That
// makes KVC a CHEAPER hole than the setter spelling closed in round 5, which is
// why it is closed rather than disclosed.
//
// `(?!=)` is what keeps the nil guard out: `==` and `!=` are comparisons, not
// writes. Reads (`provider.jsLocation`, `[provider jsLocation]`) are excluded by
// construction: neither a bare dot read nor a getter message contains `=` or a
// `:` after the name. `[provider valueForKey:@"jsLocation"]` is likewise not a
// write, and this pattern cannot match it: it requires the `forKey:` half.
//
// The KVC pattern carries its OWN capture group for the same reason the setter
// pattern does: KVC's value argument IS the right-hand side of the write. The
// key is the second argument, so the value is captured out of the first, and it
// then goes through the identical literal check as the dot and setter spellings
// -- a KVC write of `@"localhost:8081"` is READABLE and RED-on-disagreement
// exactly like `[provider setJsLocation:@"localhost:8081"]`, and a KVC write of
// anything unreadable (`[provider setValue:port forKey:@"jsLocation"]`) is RED
// for the same reason a dot write of a constant is. Nothing gets a placeholder
// and nothing skips the check.
//
// The `\s*` before `forKey` rather than `\s+`: a separator that does NOT match
// is the dangerous direction here, because an unmatched write is invisible to
// the whole-file count. ObjC formatting can put the two arguments together
// across a wrapped line, and a pin that went blind on a line wrap would be
// worse than the shape it is guarding.
const JS_LOCATION_DOT = /\.jsLocation\s*=(?!=)\s*([^;]*);/g;
const JS_LOCATION_SETTER = /setJsLocation\s*:\s*([^;]*);/g;
const JS_LOCATION_KVC = /setValue\s*:\s*([^;]*?)\s*forKey\s*:\s*@?"jsLocation"/g;
const LITERAL_LOCATION = /^@"localhost:(\d+)"$/;

// Every write in the file in ANY spelling, in source order, paired with whether
// it sits inside the live body. THREE regexes rather than one combined token,
// because each needs its OWN right-hand side capture, in a DIFFERENT argument
// position: the setter's RHS is `@"localhost:8081"` (trailing `]` trimmed), the
// dot form's is the same literal with no bracket, and KVC's is the FIRST
// argument with the key second. A single alternation can only capture one
// shape, so a setter or KVC write with an unreadable RHS (`= kSomeConst`,
// `[provider setValue:port forKey:@"jsLocation"]`) would escape the literal
// check entirely -- a worse hole than the ones being closed.
const findWrites = (source: string): { rhs: string; inBundleURL: boolean }[] => {
  const found = [
    ...[...source.matchAll(JS_LOCATION_DOT)].map((m) => ({ at: m.index ?? 0, rhs: m[1] })),
    ...[...source.matchAll(JS_LOCATION_SETTER)].map((m) => ({ at: m.index ?? 0, rhs: m[1] })),
    ...[...source.matchAll(JS_LOCATION_KVC)].map((m) => ({ at: m.index ?? 0, rhs: m[1] })),
  ].sort((a, b) => a.at - b.at);
  return found.map((w) => ({
    // A setter argument is wrapped in the message brackets: strip them.
    rhs: w.rhs.trim().replace(/\]\s*$/, '').trim(),
    inBundleURL: source === delegateCode && bundleURLBody.includes(w.rhs.trim()),
  }));
};

// Every write in the whole stripped delegate.
const everyWrite = findWrites(delegateCode);

// The single write the live body makes, if it is a literal at all.
const bodyWrite = findWrites(bundleURLBody).map((w) => w.rhs);

// Derived, never retyped: whatever the start script says, the delegate must say.
const scriptPort = pkg.scripts.start?.match(/--port\s+(\d+)/)?.[1];

// WHICH RECEIVER? Derived from the source, never hard-coded.
//
// Two assertions used to spell the identifier `provider` literally -- the one
// that reads the port back out of the assignment, and the one that reads the
// nil guard. That made a pure rename of a local variable (with the port left at
// 8082 and the app behaving identically) fail RED for no reason a developer
// could act on: renaming `provider` to `bundleProvider`, or to `p2`, is an
// ordinary tidy-up. A pin that fires on a rename has stopped pinning the port
// and started pinning a name, which is the same receiver-identity blindness
// review finding 2 was raised to kill -- reintroduced through the two
// assertions that finding never reached. So the name is CAPTURED from the
// declaration the delegate itself writes:
//
//   RCTBundleURLProvider *provider = [RCTBundleURLProvider sharedSettings];
//
// and both regexes below are built from that capture. jsLocation is a property
// on the shared singleton, so any receiver name designates the same storage; the
// name is a local spelling, not a fact about the port.
//
// Nothing here weakens the pin. A SECOND declaration is still caught, because
// the capture is anchored on `sharedSettings` -- a receiver that is not built by
// that call has no capture, `codePort` and the guard are undefined, and both
// assertions fail. That direction was verified, not assumed (see the report).
const receiver = delegateCode.match(
  /RCTBundleURLProvider\s*\*\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\[RCTBundleURLProvider\s+sharedSettings\]/,
)?.[1];

// The guard may read the location either as a property (`provider.jsLocation`)
// or as a getter message (`[provider jsLocation]`); both appear in idiomatic
// Objective-C and both are what the guard is for. The alternation here is a
// READER, not a detector -- unlike findWrites above, where a combined token
// would have hidden a right-hand side from the literal check.
const nilGuard = new RegExp(
  `if\\s*\\(\\s*(?:${receiver}\\s*\\.\\s*jsLocation|\\[\\s*${receiver}\\s+jsLocation\\])\\s*==\\s*nil\\s*\\)\\s*\\{[^}]*${receiver}\\s*\\.\\s*jsLocation\\s*=`,
);

// Matched with a regex, not toContain, so the assertion is about the ASSIGNMENT
// rather than a substring appearing anywhere in the file. The capture is the
// port as actually written in the code. The receiver comes from the capture
// above, so this reads the PORT rather than the variable's name.
const codePort = receiver
  ? bundleURLBody.match(
      new RegExp(`${receiver}\\s*\\.\\s*jsLocation\\s*=\\s*@"localhost:(\\d+)";`),
    )?.[1]
  : undefined;

describe('apps/desktop has its own Metro port, so it cannot answer for mobile', () => {
  it('ships a start script that launches Metro on a non-default port', () => {
    // Metro's default is 8081 and that is the port apps/mobile uses. A desktop
    // start script with no --port is the defect: it opens a packager on the
    // shared default, where a leftover process can serve the wrong app.
    expect(pkg.scripts.start).toBeDefined();
    expect(scriptPort).toBeDefined();
    expect(scriptPort).not.toBe('8081');
  });

  it('passes the same port to run-macos, which starts no packager of its own', () => {
    // `react-native run-macos` builds, launches, then `open`s the app -- it never
    // spawns Metro. Its --port also reaches RCT_METRO_PORT only when a packager
    // flag is passed, so with no explicit --port the built app and `npm start`
    // silently describe different ports. Pin the flag so losing it is a red test
    // rather than a silent desync.
    const macosPort = pkg.scripts.macos?.match(/--port\s+(\d+)/)?.[1];
    expect(pkg.scripts.macos).toBeDefined();
    expect(macosPort).toBe(scriptPort);
  });

  it('assigns that same port as the provider jsLocation, in code not in a comment', () => {
    // RCTBundleURLProvider appends RCT_METRO_PORT (8081) whenever the location
    // it was given contains no colon, so a bare host silently means 8081 -- the
    // port apps/mobile uses. The colon IS the mechanism: it marks the port as
    // already present. This is the assertion that stops the two sides drifting.
    expect(codePort).toBeDefined();
    expect(codePort).toBe(scriptPort);
  });

  it('writes jsLocation exactly once in the WHOLE delegate, in any spelling', () => {
    // This is the invariant that makes the port a fact about the app rather
    // than a fact about one slice of text. The app has ONE provider and ONE
    // port, so the delegate must contain exactly one write to jsLocation, and
    // it must be the one inside bundleURL. Everything GREEN below was a way
    // to satisfy the per-body assertions while a SECOND, real write decided
    // the port instead:
    //
    //   - a dead `#if 0` copy of bundleURL ahead of the live one, where
    //     methodBody's indexOf read the dead text and the live method was free
    //     to be wrong (review finding 1)
    //   - a second write via a different receiver in the same body
    //     (`[RCTBundleURLProvider sharedSettings].jsLocation = ...`), which
    //     the old line-anchored `^\s*provider\.jsLocation` count could not see
    //     because the receiver was not `provider` (review finding 2)
    //   - an override in `sourceURLForBridge`, which is called FIRST, and whose
    //     write the nil guard then PRESERVED (review finding 6)
    //   - a SETTER-form write, `[provider setJsLocation:@"localhost:8081"]`,
    //     which the dot-only token this replaced matched nothing on, so one
    //     ordinary added line put the desktop back on the port mobile owns
    //     while every assertion here stayed green (round-5 blocker)
    //
    //   - a KEY-VALUE-CODING write, `[provider setValue:@"localhost:8081"
    //     forKey:@"jsLocation"]`, which is plain NSObject API, whose key the
    //     PUBLIC header prints at RCTBundleURLProvider.h:103, so it is cheaper
    //     for a developer to reach than the setter spelling above. Round 6
    //     reproduced the original collision through it with all ten assertions
    //     green (round-6 blocker 1)
    //
    // Counting on ANY receiver, over the whole file, closes all three at once.
    // The receiver genuinely does not matter: jsLocation is a property on the
    // shared singleton, so `[RCTBundleURLProvider sharedSettings].jsLocation`
    // and `provider.jsLocation` are the same storage. Neither does the SPELLING:
    // dot syntax, the setter message and key-value coding all reach that same
    // storage, which is why all three are counted here.
    expect(everyWrite).toHaveLength(1);
    expect(everyWrite[0].inBundleURL).toBe(true);
  });

  it('defines bundleURL exactly once, so there is no decoy copy to slice into', () => {
    // Kills review finding 1 at the SOURCE rather than relying on the count
    // above to notice it. `methodBody` takes the first match of the signature,
    // so a second definition -- an `#if 0` block, a commented-out variant, or
    // a leftover copy -- silently becomes the method this pin inspects while
    // the one the compiler honours is never read. One definition, one slice.
    expect(delegateCode.match(/- \(NSURL \*\)bundleURL/g)?.length ?? 0).toBe(1);
  });

  it('assigns a bare literal, not a constant, a concatenation or an escape', () => {
    // The port has to be readable HERE or not at all. A right-hand side this
    // test cannot read is a port this test cannot pin:
    //
    //   `= kSomeoneElsesPort` -- a static const in another header. codePort
    //   would still have matched the stale literal in a trailing comment while
    //   the app actually asked for whatever the header said (review finding 4).
    //   `@"localhost:" @"8083"` -- a split literal, which the single-literal
    //   regex must not silently accept.
    //   `@"localhost\u003A8083"` -- a unicode-escaped colon, which the
    //   provider cannot see either, so it would fall back to appending 8081.
    //
    // So: exactly one write, and its RHS is exactly one literal of the form
    // @"localhost:<digits>". Anything else is RED here rather than a port that
    // quietly disagrees with package.json.
    expect(bodyWrite).toHaveLength(1);
    const literal = bodyWrite[0]?.match(LITERAL_LOCATION);
    expect(literal).not.toBeNull();
    expect(literal?.[1]).toBe(scriptPort);
  });

  it('sets that location only when none is configured', () => {
    // An unconditional assignment would overwrite a location a developer had
    // set by other means (a `defaults write` of RCT_jsLocation), and it would
    // rewrite NSUserDefaults and post the provider-updated notification on EVERY
    // bundleURL call -- a packager reconnect on every reload. Defaulting only
    // when nil keeps the pin without the churn. The receiver is the name captured
    // from the declaration above, so renaming the local stays GREEN here.
    expect(nilGuard.test(bundleURLBody)).toBe(true);
  });

  it('assigns the location exactly once, so no second write can disagree', () => {
    // Body-local companion to the whole-file count above: the single write is
    // not merely somewhere in the file, it is in HERE.
    //
    // This used to be anchored to the START OF A LINE, on the theory that the
    // nil comparison `provider.jsLocation == nil` sits mid-line while a write
    // starts its own. That anchor was doing two jobs badly: it missed writes
    // whose receiver is not `provider` (review finding 2), and it could not see
    // a write appended to an existing line. `(?!=)` is the correct
    // discriminator instead -- it inspects the `=` that actually follows the
    // `\\s*` rather than guessing from column position, so it counts real
    // writes on any receiver and still ignores `==` and `!=`. (The comment this
    // replaces claimed a lookahead "does NOT work" because `\\s*` backtracks;
    // that was a bug in the line anchoring, not a property of lookaheads, and
    // this version is tested against the guard and every decoy shape recorded
    // in the task report.)
    // Counted through findWrites, so a setter-form write inside the body is
    // counted here too and cannot slip past the body-local check while still
    // satisfying the whole-file one (or the reverse).
    expect(findWrites(bundleURLBody)).toHaveLength(1);
  });

  it('returns the INSTANCE jsBundleURLForBundleRoot, not the class overload', () => {
    // BLOCKER 2, the cheap half. RCTBundleURLProvider also exposes public class
    // methods, `-jsBundleURLForBundleRoot:packagerHost:enableDev:...`
    // (RCTBundleURLProvider.h:131-135 and :144-151), which build the URL from the
    // packagerHost ARGUMENT and never read jsLocation at all. Returning one of
    // those decides the port with the pinned write present, untouched and
    // correct -- every write-shaped assertion in this file still passes, because
    // none of them models "the URL the app requests comes from that literal".
    //
    // What this assertion pins is the RECEIVER of the call, so it is deliberately
    // a weaker claim than "the instance method specifically" -- see the NOT
    // GUARANTEED entry for why the class overload is disclosed rather than
    // pattern-matched out, and what catches it for real.
    // The return in the DEBUG arm, not the FIRST return in the body: in the
    // shipped delegate the release `#else` arm's `[NSBundle ...]` return is the
    // one a plain first-match search finds, and reading that would have failed
    // this file's own source. Splitting on the preprocessor directive is what
    // makes the DEBUG arm the subject.
    const debugArm = bundleURLBody.split(/#else/)[0] ?? '';
    const returnExpr = messageSend(debugArm);
    expect(returnExpr).toBeDefined();
    // 1. It is a send of the selector that builds the URL.
    expect(returnExpr).toMatch(/jsBundleURLForBundleRoot/);
    // 2. Its receiver is NOT the class. `[RCTBundleURLProvider jsBundle...` is
    // the class-method overload; the instance forms are `[<local> jsBundle...`
    // and `[[RCTBundleURLProvider sharedSettings] jsBundle...`. This is the line
    // that turns BLOCKER 2 from GREEN into RED.
    expect(returnExpr).not.toMatch(/^\[\s*RCTBundleURLProvider\s+jsBundleURLForBundleRoot/);
    // 3. And it really is one of the two instance receivers, so the check above
    // cannot be satisfied by deleting the call. `receiver` is the CAPTURED
    // local name, so a rename stays GREEN (BLOCKER 3), and the inline singleton
    // form is accepted because it is the same object -- that keeps this
    // assertion off the rename-shaped false RED rather than adding a new one.
    expect(returnExpr).toMatch(
      new RegExp(
        `^\\[\\s*(?:${receiver}\\s+jsBundleURLForBundleRoot|\\[RCTBundleURLProvider\\s+sharedSettings\\]\\s+jsBundleURLForBundleRoot)`,
      ),
    );
  });

  it('keeps the DEBUG/Release branch shape the existing delegate spec pins', () => {
    // The provider call is only the DEBUG arm; RELEASE must still read the
    // pre-bundled .jsbundle off disk. If a future edit collapsed the #if, the
    // release app would try to reach a packager that does not exist.
    expect(delegate).toMatch(/#if DEBUG[\s\S]*jsBundleURLForBundleRoot/);
    expect(delegate).toMatch(/#else[\s\S]*URLForResource:@"main"/);
  });
});

// WHAT THIS PIN GUARANTEES, AND WHAT IT DOES NOT. Stated explicitly because a
// source pin that claims more than it checks is what cost this task three
// review rounds; the honest boundary is part of the deliverable.
//
// GUARANTEED (each of these was a real mutation that read GREEN before):
//   - package.json scripts.start names a port, and it is not Metro's shared
//     default. This is the ONE place the digits are written.
//   - scripts.macos carries the same --port, so a build+launch cannot describe
//     a different packager than `npm start` starts.
//   - the delegate's one live jsLocation write is a literal of the form
//     @"localhost:<digits>" whose digits EQUAL the start script's, with the
//     colon present -- the colon is what stops RCTBundleURLProvider appending
//     its own default.
//   - that write is nil-guarded, so it neither clobbers a location the
//     developer configured nor reposts provider-updated on every reload.
//   - jsLocation is written EXACTLY ONCE in the whole delegate -- on ANY
//     receiver, and in ANY of the three legal spellings (`.jsLocation =` dot
//     syntax, a `setJsLocation:` message, or `setValue:forKey:@"jsLocation"`
//     key-value coding) -- and bundleURL is defined exactly once, so no dead
//     `#if 0` copy, no second receiver, no sourceURLForBridge override and no
//     setter- or KVC-form write can quietly decide the port instead. The single
//     write's right-hand side must be a literal of the form
//     @"localhost:<digits>" equal to the start script's port, whichever
//     spelling it used.
//   - the return is a message send on the CONFIGURED RECEIVER, so the URL
//     comes from the provider whose jsLocation was just pinned.
//   - The receiver NAME is not pinned: it is captured from the declaration the
//     delegate writes, so renaming the local is GREEN and a receiver that is not
//     built by `[RCTBundleURLProvider sharedSettings]` is RED.
//   - comments cannot satisfy any of the above: block SPANS, whole-line `//`
//     and trailing `//` comments are all stripped before anything is matched.
//
// NOT GUARANTEED -- accepted on purpose, because defending a three-line port
// pin against arbitrary sabotage is not what this is for:
//   - A bare @"localhost" with the colon deleted, which would make
//     RCTBundleURLProvider append its default (8081) and reproduce the original
//     mobile/desktop collision byte for byte. This is NOT defended as its own
//     assertion, and the ruling accepted it that way -- but note it is not left
//     green either: it fails RED as a side effect of the literal-RHS
//     requirement, because @"localhost" is not a @"localhost:<digits>" form.
//     What is not guaranteed is that it fails for the RIGHT reason, or that a
//     future edit cannot find some other shape this file happens to reject.
//   - REACHABILITY. An early `return` placed above the provider code (a
//     release .jsbundle read placed first in the DEBUG arm, say) makes the
//     pinned write unreachable while every regex here still passes. Catching
//     that needs either running the app or a full control-flow analysis.
//     Instead the controller performs a real macOS BUILD AND RUN against the
//     packager on this port before this task is committed, which catches the
//     real-world version of this class.
//   - Anything outside this file. A macro, an -include, or a category in a
//     different translation unit that writes jsLocation is invisible to a pin
//     over one source file. The literal-RHS requirement is what keeps that
//     door from being walked through casually: an unreadable right-hand side
//     is RED here.
//   - A direct write to the provider's BACKING STORE, i.e.
//     [[NSUserDefaults standardUserDefaults] setObject:... forKey:@"RCT_jsLocation"],
//     which bypasses the provider object and therefore every spelling this file
//     can see. Accepted rather than closed, on evidence rather than taste: the
//     key RCT_jsLocation appears NOWHERE in RCTBundleURLProvider.h -- it exists
//     only inside React Native's private RCTBundleURLProvider.mm -- so a
//     developer reading the provider's public API has no way to learn the key
//     without deliberately digging into the library's internals, then hardcoding
//     a defaults key by hand to move the port. That is a more contrived act than
//     the setter spelling (which the header advertises directly, and which IS
//     therefore caught) and than the accepted bare-localhost case above (an edit
//     to a literal this file already looks at). Writing the backing store is a
//     different kind of move, not a typo in the port.
//   - THE CLASS-METHOD OVERLOAD, which is the worst hole in this file and is
//     disclosed here rather than defended:
//       return [RCTBundleURLProvider jsBundleURLForBundleRoot:@"index"
//                                           packagerHost:@"localhost:8081"
//                                                enableDev:YES ...];
//     RCTBundleURLProvider.h:131-135 and :144-151 declare these CLASS methods
//     and RCTBundleURLProvider.mm builds the URL from the packagerHost ARGUMENT
//     without ever reading jsLocation (verified in node_modules). So the pinned
//     write stays in place, holds the right literal, is still the only write in
//     the file, and the app asks for 8081 -- the whole pin is satisfied and the
//     original mobile/desktop collision is back. Unlike every other entry here
//     it requires NO write at all, which is precisely why it is the class this
//     file cannot close by counting writes.
//     Honest severity, cutting against the disclosure: the header's own doc
//     comment discourages these overloads ("Generally you should use the
//     instance method ... which includes logic to guess if the packager is
//     running and fall back to a pre-packaged bundle if it is not", .h:116-118),
//     so this is less likely to be typed by accident than the KVC write that IS
//     caught. The assertion above narrows it -- the return must be a send on the
//     captured receiver, so the class form is RED -- but it is a NARRATIVE
//     boundary, not a proof: the call could be routed through the receiver's own
//     class spelling, or the host could arrive as a bare `localhost` and let the
//     provider append 8081, and neither is this file's business to police.
//     COMPENSATING CONTROL: the controller performs a real macOS BUILD AND RUN
//     against a packager on this port before the task is committed. That is the
//     control that catches this version of the class, because it observes the
//     port actually requested rather than reasoning about the text that requests
//     it.
//
// Every failure mode in this file is RED. Over-stripping a `//` inside a string
// literal, or a literal shape these regexes refuse to read, breaks the build
// rather than shipping a wrong port -- which is the side to err on.
