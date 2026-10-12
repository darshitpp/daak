import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * CLICKING A MULTILINE TEXT FIELD ABORTS THE PROCESS.
 *
 * On 2026-10-04 the app aborted twice. The stack named AppKit, and the
 * exception reason (captured from a standalone AppKit harness, not guessed)
 * was:
 *
 *   NSWindow: -_oldFirstResponderBeforeBecoming is not a valid message
 *   outside of a responder's implementation of -becomeFirstResponder.
 *
 *   RCTTextInputHandleCommand focus
 *   -[RCTTextInputComponentView focus]      RCTTextInputComponentView.mm:557
 *   -[_backedTextInputView becomeFirstResponder]
 *
 * MEASURED, NOT ASSUMED. A standalone AppKit harness varied one thing at a
 * time and produced this table:
 *
 *   [NSTextView becomeFirstResponder]          RAISES  (isKey=1 AND isKey=0)
 *   [[NSWindow makeFirstResponder:] view]      ok
 *   [NSTextField becomeFirstResponder]         ok
 *   [NSTextView resignFirstResponder]          RAISES  (_newFirstResponderAfterResigning)
 *
 * Three consequences this file depends on:
 *
 *  1. It is NOT a key-window problem. It raised identically with the window
 *     key and with it ordered out, so a key-window subclass, a change to
 *     -orderOut, or an activation-order change would each have been a guess.
 *  2. AppKit permits a text view to become first responder ONLY from inside
 *     -[NSWindow makeFirstResponder:]. react-native-macos sends it a direct
 *     message at RCTTextInputComponentView.mm:557. That is correct for iOS and
 *     aborts on macOS.
 *  3. Plain NSTextView raises too, so RCTUITextView's -becomeFirstResponder
 *     override is the MESSENGER, not the cause. A plain NSTextField does not
 *     raise, which is why single-line inputs (the Settings rename box,
 *     NameDeviceScreen) mounted and only MULTILINE inputs killed the app:
 *     the note field in packages/ui/src/screens/ThreadScreen.tsx (SendScreen
 *     and ComposerBar held the other two, and are deleted).
 *
 * The fix is a category on RCTUITextView, in the APP target, for the same
 * reason RCTUITextFieldTypingAttributes.mm lives there: node_modules is
 * gitignored, so a patch there dies on the next install, and bumping
 * react-native-macos is a migration rather than a fix.
 *
 * WHY THIS IS A CATEGORY AND NOT A SUBCLASS. React instantiates the class
 * itself, at RCTTextInputComponentView.mm:87 and :826. A subclass would never
 * be constructed.
 *
 * THE RECURSION IS REAL AND MEASURED. -[NSWindow makeFirstResponder:] re-enters
 * the responder's own -becomeFirstResponder (harness maxDepth=2). So the
 * override must distinguish the OUTER call from the NESTED one, and the nested
 * pass must fall through to [super becomeFirstResponder], which is legal there
 * because AppKit is inside makeFirstResponder: by that point.
 *
 * REPLACING THE METHOD REPLACES ITS NOTIFICATION. RCTUITextView.mm:213-225
 * notifies its delegate after [super becomeFirstResponder] succeeds. An
 * override that returns without doing so leaves React's TextInput state
 * machine un-notified, so the fix has to send the notification itself.
 */
const APP = join(__dirname, '..');
const MACOS = join(APP, 'macos');
const IMPL_PATH = join(MACOS, 'Daak-macOS', 'RCTUITextViewFirstResponder.mm');
const HEADER_PATH = join(MACOS, 'Daak-macOS', 'RCTUITextViewFirstResponder.h');
const PBXPROJ_PATH = join(MACOS, 'Daak.xcodeproj', 'project.pbxproj');

// Read through these rather than at module scope: a missing file must make an
// ASSERTION fail, not throw during collection. A suite that errors on load
// proves nothing about which behaviour is missing.
const readIfPresent = (path: string): string =>
  existsSync(path) ? readFileSync(path, 'utf8') : '';

// Comments state the identifiers being asserted, so an unstripped toContain
// would be satisfied by the prose. ObjC uses // only; newlines are kept so the
// anchors still mean what they say.
const stripComments = (s: string): string => s.replace(/\/\/.*$/gm, '');
const code = stripComments(readIfPresent(IMPL_PATH));
const header = readIfPresent(HEADER_PATH);
const pbxproj = readIfPresent(PBXPROJ_PATH);

// Brace-balanced slice from a selector to the close of the method it opens, so
// a resolve in a DIFFERENT method cannot satisfy an assertion about this one.
const blockEndAt = (src: string, openAt: number): number => {
  let depth = 0;
  for (let i = src.indexOf('{', openAt); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}' && --depth === 0) return i;
  }
  throw new Error('unbalanced braces');
};

const methodBody = (selector: string): string => {
  const at = code.indexOf(selector);
  expect(at, selector + ' is not implemented').toBeGreaterThan(-1);
  const method = code.slice(at);
  return method.slice(0, blockEndAt(method, 0) + 1);
};

// The same slice for a file-static C function. The begin-editing notification
// lives in one, and a method-body slice cannot see it.
const functionBody = (name: string): string => {
  const at = code.search(new RegExp('static\\s+void\\s+' + name + '\\s*\\('));
  expect(at, name + ' helper is not implemented').toBeGreaterThan(-1);
  const fn = code.slice(at);
  return fn.slice(0, blockEndAt(fn, 0) + 1);
};

// The compile needs xcrun and the CocoaPods output (`pod install` writes
// macos/Pods, and Git does not hold it). Without both, the checks that read
// Pods skip. The text checks that read only the repo run everywhere.
const HAS_PODS = existsSync(join(MACOS, 'Pods'));
const CAN_COMPILE = process.platform === 'darwin' && HAS_PODS;
const SDK = CAN_COMPILE
  ? execFileSync('/usr/bin/xcrun', ['--show-sdk-path'], { encoding: 'utf8' }).trim()
  : '';
const PODS_PUBLIC_REACT_CORE = join(MACOS, 'Pods', 'Headers', 'Public', 'React-Core');
// R61: on 0.83, React/RCTUIKit.h re-exports RCTUIKit/RCTUIKit.h, which the
// React-RCTUIKit pod publishes. Without this include the syntax check dies in
// React-Core's own header.
const PODS_PUBLIC_REACT_UIKIT = join(MACOS, 'Pods', 'Headers', 'Public', 'React-RCTUIKit');

// Same flags the app target compiles with, from the target's common-args.resp.
// -fsyntax-only keeps this ~1.3s: the same type check, no object file, no link.
const CLANG_ARGS = [
  '-fsyntax-only',
  '-fobjc-arc',
  '-x',
  'objective-c++',
  '-std=c++20',
  '-isysroot',
  SDK,
  '-target',
  'arm64-apple-macos14.0',
  '-I',
  PODS_PUBLIC_REACT_CORE,
  '-I',
  PODS_PUBLIC_REACT_UIKIT,
  IMPL_PATH,
];

const compileIt = (): { errors: string[]; output: string } => {
  let output = '';
  try {
    execFileSync('/usr/bin/clang', CLANG_ARGS, { encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    output = (e.stdout ?? '') + (e.stderr ?? '');
  }
  return { errors: output.split('\n').filter((l) => /\berror:/.test(l)), output };
};

describe('the multiline text input takes focus without aborting', () => {
  // The headline. A previous revision of this work asserted on source TEXT
  // only and shipped files that did not compile. A text assertion cannot tell
  // a resolved message send from an unresolved one.
  it.skipIf(!CAN_COMPILE)('COMPILES against the real React-Core headers with no errors', () => {
    expect(existsSync(PODS_PUBLIC_REACT_CORE), PODS_PUBLIC_REACT_CORE + ' missing: run pod install').toBe(true);
    expect(existsSync(IMPL_PATH), IMPL_PATH + ' missing').toBe(true);
    const { errors, output } = compileIt();
    expect(errors, 'clang -fsyntax-only failed:\n' + output).toEqual([]);
  });

  // On RCTUITextView, the class RCTTextInputComponentView.mm:87 and :826
  // actually instantiate for props.multiline === true. A category on NSTextView
  // would not compile (the delegate and the superclass declarations are on
  // React's subclass) and a subclass would never be constructed.
  it('categorizes RCTUITextView, the class React instantiates', () => {
    expect(code).toMatch(/@implementation\s+RCTUITextView\s*\(\s*\w+\s*\)/);
    expect(header).toMatch(/@interface\s+RCTUITextView\s*\(\s*\w+\s*\)/);
    // Without this import the category sees only NSTextView's interface, and
    // textInputDelegate does not exist on it.
    expect(header).toMatch(/#import\s*<React\/RCTUITextView\.h>/);
  });

  // Unguarded, TARGET_OS_OSX evaluates to 0, the file compiles to nothing, and
  // the app aborts with the original exception while every source-level
  // assertion here still passes: the fix present in the tree, absent from the
  // binary, with no compiler diagnostic anywhere.
  it('is compiled only where the macOS class exists', () => {
    expect(code).toMatch(/#import <TargetConditionals\.h>[\s\S]*#if\s+TARGET_OS_OSX/);
    expect(header).toMatch(/#import <TargetConditionals\.h>[\s\S]*#if\s+TARGET_OS_OSX/);
    const guardAt = code.indexOf('#if TARGET_OS_OSX');
    const implAt = code.indexOf('@implementation');
    const endifAt = code.lastIndexOf('#endif');
    expect(guardAt).toBeGreaterThan(-1);
    expect(implAt).toBeGreaterThan(guardAt);
    expect(endifAt).toBeGreaterThan(implAt);
  });

  // The actual fix. A direct [super becomeFirstResponder] is the abort:
  // AppKit's -_oldFirstResponderBeforeBecoming is only valid inside
  // -makeFirstResponder:, and RCTTextInputComponentView.mm:557 is not.
  it('routes the outer focus through the window, the only legal entry point', () => {
    const focus = methodBody('becomeFirstResponder');
    expect(focus).toMatch(/\[\s*[A-Za-z_][\w.]*\s+makeFirstResponder:\s*self\s*\]/);
  });

  // MEASURED: -[NSWindow makeFirstResponder:] re-enters this method
  // (harness maxDepth=2). Calling makeFirstResponder: again from the nested
  // pass would recurse forever. The nested pass must reach [super
  // becomeFirstResponder], which is legal there precisely because AppKit is
  // inside makeFirstResponder: by then.
  it('guards the reentrancy and falls through to super on the nested pass', () => {
    // The counter is FILE-SCOPED, not declared in the method. One counter has
    // to serve both overrides: -[NSWindow makeFirstResponder:] drives the old
    // responder's -resignFirstResponder from inside the focus transition, so
    // the two methods must agree on the depth or the guard in one of them
    // reads a value the other never wrote. A static local inside a method body
    // would be a second, unrelated counter.
    expect(code).toMatch(/static\s+(NSInteger|int|unsigned)\s+\w*[Dd]epth\w*\s*=\s*0\s*;/);

    const focus = methodBody('becomeFirstResponder');
    // "> 0" and NOT "depth > 1" or "depth > 2". AppKit's nested pass runs at
    // depth 1: the outer path increments to 1 and then the window calls back
    // in. A guard of "> 1" therefore does not fire on the nested pass, the
    // nested pass increments again, and the transition never returns. The
    // harness measured a maximum depth of 2 for the whole sequence, which is
    // one outer increment plus one nested pass.
    const guardAt = focus.search(/[Dd]epth\w*\s*>\s*0/);
    expect(guardAt, 'no reentrancy guard').toBeGreaterThan(-1);
    // Super must come AFTER the guard, and only on the nested path.
    const superAt = focus.indexOf('[super becomeFirstResponder]');
    expect(superAt).toBeGreaterThan(-1);
    expect(superAt).toBeGreaterThan(guardAt);
    // The depth has to come back down, or the first click latches the guard and
    // every later focus silently fails.
    expect(focus).toMatch(/[Dd]epth\w*\s*-=\s*1/);
  });

  // MEASURED: resigning an NSTextView directly raises
  // -_newFirstResponderAfterResigning. Fixing only the focus path would move
  // the abort from click to blur, which is the same crash on a later key.
  it('fixes the resign path too, or the app aborts on blur instead', () => {
    const resign = methodBody('resignFirstResponder');
    expect(resign).not.toMatch(/\[super resignFirstResponder\]/);
    // WHO HOLDS FOCUS, ASKED FIRST. An NSTextField holds focus through its own
    // field editor, which is an NSTextView, so a blur aimed at one field while
    // a single-line field is focused must not take that focus away. This is the
    // check that prevents it, and it must come BEFORE the window transition:
    // after the transition there is nothing left to protect.
    const owns = resign.search(/firstResponder\s*!=\s*self/);
    expect(owns, 'resign does not check who holds focus').toBeGreaterThan(-1);
    const clear = resign.search(/makeFirstResponder:\s*nil/);
    expect(clear).toBeGreaterThan(-1);
    expect(owns, 'the ownership check runs after focus is already gone').toBeLessThan(clear);
  });

  // RCTUITextView.mm:213-225 notifies its delegate AFTER super succeeds. An
  // override that replaces the method without doing so leaves React's TextInput
  // state machine un-notified, and the field mounts but never reports being
  // focused.
  it('re-sends the delegate notification the override replaced', () => {
    // The notification lives in a file-static helper, not inline in the method.
    // Inlining it would have to be written twice: once on the nested pass and
    // once on the outer path, and the nested pass must NOT notify at all (see
    // below), so an inline pair is exactly the double notification defect.
    const helper = functionBody('DaakNotifyBeginEditing');
    expect(helper).toMatch(/textInputDelegate/);
    expect(helper).toMatch(/textInputDidBeginEditing/);

    // Exactly ONE call from the method. The method has three return paths
    // (nested, no window, window), so "one call" is the statement that makes
    // "one notification per transition" checkable at all. Two or more calls
    // cannot be reasoned about from the text alone and were the defect.
    const focus = methodBody('becomeFirstResponder');
    const calls = focus.match(/DaakNotifyBeginEditing\s*\(/g) ?? [];
    expect(calls.length, 'expected one notification call, found ' + calls.length).toBe(1);

    // AFTER the makeFirstResponder: call: a notification sent before the focus
    // succeeded reports a lie. The nested pass is AppKit's own notification,
    // which RCTUITextView's replaced implementation already sent -- this path
    // is the one that runs when AppKit does not call -becomeFirstResponder at
    // all, because the view is already the first responder.
    const makeAt = focus.search(/makeFirstResponder:\s*self/);
    expect(makeAt).toBeGreaterThan(-1);
    const notifyAt = focus.indexOf('DaakNotifyBeginEditing');
    expect(notifyAt).toBeGreaterThan(makeAt);
  });

  // The return value is AppKit's, not a guess. React reads it, and returning a
  // constant would report focus that never happened.
  it('returns what AppKit returned', () => {
    const focus = methodBody('becomeFirstResponder');
    expect(focus).not.toMatch(/return\s+(YES|NO|true|false)\s*;/);
  });

  // Without this the app compiles, links, launches, and aborts on the first
  // click with exactly the original exception: the fix present in the tree,
  // absent from the binary.
  it.skipIf(!HAS_PODS)('is a Sources-phase entry of the Daak-macOS target', () => {
    expect(pbxproj, 'project.pbxproj missing').not.toBe('');
    const phaseAt = pbxproj.indexOf(
      '514201452437B4B30078DB4F /* Sources */ = {\n\t\t\tisa = PBXSourcesBuildPhase;',
    );
    expect(phaseAt).toBeGreaterThan(-1);
    const phase = pbxproj.slice(phaseAt, pbxproj.indexOf('runOnlyForDeploymentPostprocessing', phaseAt));
    expect(phase).toContain('RCTUITextViewFirstResponder.mm in Sources');

    const fileRef = pbxproj.match(
      /\n\t\t(\w+) \/\* RCTUITextViewFirstResponder\.mm \*\/ = \{isa = PBXFileReference;[^}]*\};/,
    );
    expect(fileRef).not.toBeNull();
    const buildFile = pbxproj.match(
      /\n\t\t(\w+) \/\* RCTUITextViewFirstResponder\.mm in Sources \*\/ = \{isa = PBXBuildFile; fileRef = (\w+)/,
    );
    expect(buildFile).not.toBeNull();
    expect(buildFile?.[2]).toBe(fileRef?.[1]);

    // -ObjC: a category in a static archive is dead-stripped without it, and
    // the app aborts identically.
    for (const cfg of ['debug', 'release']) {
      const xcconfig = readIfPresent(
        join(MACOS, 'Pods', 'Target Support Files', 'Pods-Daak-macOS', 'Pods-Daak-macOS.' + cfg + '.xcconfig'),
      );
      expect(xcconfig, cfg + ' xcconfig missing').toMatch(/^OTHER_LDFLAGS = .*\s-ObjC(\s|$)/m);
    }
  });

  // A category redefines methods on React's class. It must not also declare
  // the class, which would replace React's implementation wholesale.
  it('categorizes rather than redefining the class', () => {
    expect(code).not.toMatch(/@implementation\s+RCTUITextView\s*$/m);
  });
});
