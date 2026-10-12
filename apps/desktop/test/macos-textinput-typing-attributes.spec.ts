import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// On 2026-10-02 the macOS app built and linked for the first time, launched,
// and then died the instant any TextInput mounted:
//
//   *** Terminating app due to uncaught exception 'NSInvalidArgumentException',
//   reason: '-[RCTUITextField typingAttributes]: unrecognized selector'
//   frame 5: -[RCTTextInputComponentView initWithFrame:]
//
// RCTBackedTextInputViewProtocol.h:63 declares `typingAttributes`, and
// RCTTextInputComponentView.mm sends it at :92 (copied in init) and :817
// (_updateTypingAttributes). On macOS the single-line backed view is
// RCTUITextField, an NSTextField subclass, and NSTextField has no such property
// -- only the MULTILINE RCTUITextView (an NSTextView) implements it, at
// Libraries/Text/TextInput/Multiline/RCTUITextView.mm:202.
//
// The fix cannot live in node_modules (gitignored; dies on the next install)
// and cannot be a version bump (0.83 is a whole migration), so it lives in the
// app target as a category on RCTUITextField.
//
// REVIEWER-5, the finding that produced the COMPILE test below: the previous
// revision of this file asserted on source TEXT only and shipped a .mm with
// compile errors past a 5/5 green run. A text assertion cannot tell a
// resolved message send from an unresolved one. So the headline test here
// invokes clang on the real file; the rest is cheap structural corroboration.
const APP = join(__dirname, '..');
const MACOS = join(APP, 'macos');
const IMPL_PATH = join(MACOS, 'Daak-macOS', 'RCTUITextFieldTypingAttributes.mm');
const HEADER_PATH = join(MACOS, 'Daak-macOS', 'RCTUITextFieldTypingAttributes.h');
const HEADER = readFileSync(HEADER_PATH, 'utf8');
const IMPL = readFileSync(IMPL_PATH, 'utf8');
const PBXPROJ = readFileSync(join(MACOS, 'Daak.xcodeproj', 'project.pbxproj'), 'utf8');

// Same reason as macos-file-picker.spec.ts: these files explain the very
// identifiers being asserted, so an unstripped toContain is satisfied by the
// prose. ObjC here uses // only, and the strip keeps newlines so the line
// anchors below still mean what they say.
const stripComments = (s: string): string => s.replace(/\/\/.*$/gm, '');
const code = stripComments(IMPL);

// Brace-balanced slice from a selector to the close of the method it opens, so
// a resolve in a DIFFERENT method cannot satisfy an assertion about this one.
const blockEndAt = (src: string, openAt: number): number => {
  let depth = 0;
  for (let i = src.indexOf('{', openAt); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}' && --depth === 0) return i;
  }
  throw new Error(`unbalanced braces from ${openAt}`);
};

const methodBody = (selector: string): string => {
  const at = code.indexOf(selector);
  expect(at, `${selector} is not implemented`).toBeGreaterThan(-1);
  const method = code.slice(at);
  return method.slice(0, blockEndAt(method, 0) + 1);
};

// The compile, with nothing from /tmp in it.
//
// /tmp/daak-dd is xcodebuild's DerivedData for this project and is wiped on
// reboot, so the flags come from the REPO instead:
//   -isysroot  xcrun --show-sdk-path   (the installed macOS SDK)
//   -I         macos/Pods/Headers/Public/React-Core -- the exact directory the
//              app target's HEADER_SEARCH_PATHS adds, containing
//              React/RCTUITextField.h, a symlink CocoaPods wrote to
//              node_modules/react-native-macos/Libraries/Text/TextInput/
//              Singleline/RCTUITextField.h
//   -target    arm64-apple-macos11.0  (the deployment target; the same
//              -target the target's common-args.resp carries)
//   -std c++20 and -fobjc-arc          (also from that resp file)
//
// -fsyntax-only is the point: the same type-checking xcodebuild performs, with
// no object file and no link step, so this stays a ~1.3s test.
// The compile needs xcrun and the CocoaPods headers, so it runs on macOS only.
// The text checks below read the repo and run everywhere.
const CAN_COMPILE = process.platform === 'darwin';
const SDK = CAN_COMPILE
  ? execFileSync('/usr/bin/xcrun', ['--show-sdk-path'], { encoding: 'utf8' }).trim()
  : '';
const PODS_PUBLIC_REACT_CORE = join(MACOS, 'Pods', 'Headers', 'Public', 'React-Core');
// R61: on 0.83, React/RCTUIKit.h re-exports RCTUIKit/RCTUIKit.h, which the
// React-RCTUIKit pod publishes. Without this include the syntax check dies in
// React-Core's own header.
const PODS_PUBLIC_REACT_UIKIT = join(MACOS, 'Pods', 'Headers', 'Public', 'React-RCTUIKit');
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

// Warnings are deliberately NOT silenced, and this target sets no -Werror
// anywhere (project.pbxproj, either Pods xcconfig, common-args.resp -- all
// grepped). So a warning is genuinely non-fatal here, but it is still noise:
// the two that RCTUITextField.h itself provokes -- it redeclares `editable`
// and `defaultTextAttributes` from RCTBackedTextInputViewProtocol with
// different attributes -- land on upstream header lines, not on this file's,
// and the compile test below asserts only on `error:` lines.
const compileTheImplementation = (): { errors: string[]; output: string } => {
  let output = '';
  try {
    execFileSync('/usr/bin/clang', CLANG_ARGS, { encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    output = `${(err as { stdout?: string }).stdout ?? ''}${(err as { stderr?: string }).stderr ?? ''}`;
  }
  return { errors: output.split('\n').filter((l) => /\berror:/.test(l)), output };
};

describe('the macOS typingAttributes category exists and is compiled', () => {
  // The headline. The revision this replaces read the .mm as text and went 5/5
  // green on a file that could not compile: several "no visible @interface"
  // errors, because the category was on NSTextField while attributedText,
  // selectedTextRange and defaultTextAttributes are declared on React's own
  // RCTUITextField subclass. A text assertion cannot see that; a compiler can.
  it.skipIf(!CAN_COMPILE)('COMPILES against the real React-Core headers with no errors', () => {
    expect(existsSync(PODS_PUBLIC_REACT_CORE), `${PODS_PUBLIC_REACT_CORE} missing: run pod install`).toBe(true);
    const { errors, output } = compileTheImplementation();
    expect(errors, `clang -fsyntax-only failed:\n${output}`).toEqual([]);
  });

  // On RCTUITextField, the class RCTTextInputComponentView.mm:88 actually
  // instantiates for a single-line input. A category on NSTextField cannot
  // compile (the properties are declared on the subclass), and one on
  // RCTUITextView would do nothing for the field that crashes. The name has to
  // come from React's own header so the fix cannot drift onto a superclass that
  // lacks the selectors.
  it('adds the property on RCTUITextField, the class React instantiates', () => {
    expect(code).toMatch(/@implementation\s+RCTUITextField\s*\(\s*\w+\s*\)/);
    expect(HEADER).toMatch(/@interface\s+RCTUITextField\s*\(\s*\w+\s*\)/);
    // The import is what makes the subclass's declarations visible. Without it
    // the category sees only NSTextField's interface and every error returns.
    expect(HEADER).toMatch(/#import\s*<React\/RCTUITextField\.h>/);
    // BOTH halves. A getter alone still throws on the _updateTypingAttributes
    // assignment at :817, which runs on the first keystroke.
    expect(code).toMatch(/-\s*\(NSDictionary[^)]*\)\s*typingAttributes\b/);
    expect(code).toMatch(/-\s*\(void\)\s*setTypingAttributes\s*:/);
    // Not a bare property redeclaration: @property would synthesize storage we
    // cannot add to another class's ivars from a category.
    expect(code).not.toMatch(/@property[^;]*typingAttributes/);
  });

  // `attributes` is on neither NSTextField nor RCTUITextField -- zero
  // declarations in the AppKit SDK -- so a message send to it cannot compile.
  // The previous revision's last fallback was exactly that send, and was one of
  // those errors. RCTBackedTextInputViewProtocol.h:90 says to use
  // `attributedText.string` instead; there is no correct replacement to
  // re-point at, so the branch is deleted rather than fixed.
  it('does not message a selector that does not exist', () => {
    expect(code).not.toMatch(/\[\s*self\s+attributes\s*\]/);
  });

  // The whole point of a category on a UIKit-named class is that it may be
  // compiled on a target where that class is a UITextField rather than an
  // NSTextField. Unguarded, this file is a lie about where it is safe.
  it('is compiled only where the macOS class exists', () => {
    // TargetConditionals FIRST. Undefined in the preprocessor, TARGET_OS_OSX
    // evaluates to 0, the whole file silently compiles to nothing, and the app
    // crashes with the original exception while every source-level assertion
    // here still passes -- the fix present in the tree and absent from the
    // binary, with no compiler diagnostic anywhere.
    expect(code).toMatch(/#import <TargetConditionals\.h>[\s\S]*#if\s+TARGET_OS_OSX/);
    expect(HEADER).toMatch(/#import <TargetConditionals\.h>[\s\S]*#if\s+TARGET_OS_OSX/);
    const guardAt = code.indexOf('#if TARGET_OS_OSX');
    const implAt = code.indexOf('@implementation');
    const endifAt = code.lastIndexOf('#endif');
    expect(guardAt).toBeGreaterThan(-1);
    expect(implAt).toBeGreaterThan(guardAt);
    expect(endifAt).toBeGreaterThan(implAt);
  });

  // Without this the app compiles, links, launches, and crashes on the first
  // keystroke with exactly the same exception as before -- the fix present in
  // the tree and absent from the binary. The surviving mutation that turns
  // this whole file green if it is dropped.
  it('is a Sources-phase entry of the Daak-macOS target', () => {
    // Anchor on the phase's DEFINITION, not on a reference to it: the same id
    // appears first inside PBXNativeTarget's buildPhases list, and slicing from
    // there to the next runOnlyForDeploymentPostprocessing spans half the file
    // and stops BEFORE this phase -- which reads as "not registered" no matter
    // what project.pbxproj says. The isa line is what makes it the definition.
    const phaseAt = PBXPROJ.indexOf(
      '514201452437B4B30078DB4F /* Sources */ = {\n\t\t\tisa = PBXSourcesBuildPhase;',
    );
    expect(phaseAt).toBeGreaterThan(-1);
    const phase = PBXPROJ.slice(phaseAt, PBXPROJ.indexOf('runOnlyForDeploymentPostprocessing', phaseAt));
    expect(phase).toContain('RCTUITextFieldTypingAttributes.mm in Sources');

    // A name in the phase that resolves to no build file is decoration: the
    // fileRef must exist AND the Sources entry must point at it.
    const fileRef = PBXPROJ.match(
      /\n\t\t(\w+) \/\* RCTUITextFieldTypingAttributes\.mm \*\/ = \{isa = PBXFileReference;[^}]*\};/,
    );
    expect(fileRef).not.toBeNull();
    const buildFile = PBXPROJ.match(
      /\n\t\t(\w+) \/\* RCTUITextFieldTypingAttributes\.mm in Sources \*\/ = \{isa = PBXBuildFile; fileRef = (\w+)/,
    );
    expect(buildFile).not.toBeNull();
    expect(buildFile?.[2]).toBe(fileRef?.[1]);

    // -ObjC: a category in a static archive is dead-stripped without it and the
    // app crashes identically -- present in the tree, absent from the binary.
    // CocoaPods emits it into the generated xcconfig the target inherits, so
    // both configurations are covered by checking both.
    for (const cfg of ['debug', 'release']) {
      const xcconfig = readFileSync(
        join(MACOS, 'Pods', 'Target Support Files', 'Pods-Daak-macOS', `Pods-Daak-macOS.${cfg}.xcconfig`),
        'utf8',
      );
      expect(xcconfig, `${cfg} xcconfig`).toMatch(/^OTHER_LDFLAGS = .*\s-ObjC(\s|$)/m);
    }
  });

  // React copies the getter's result in init and compares it in
  // shouldFallbackToBareTextComparison's sibling path. nil there is a crash at
  // :92 or a text-diff that never matches, so the getter has to answer with
  // SOMETHING on every path -- an empty dictionary is the safe one: it is
  // non-nil, and it reads as no insensitive attributes.
  it('answers the getter on every path and never with nil', () => {
    const getter = methodBody('typingAttributes');
    expect(getter).not.toMatch(/return\s+nil\b/);
    // The empty-dictionary fallback, and it is the LAST thing the getter can
    // do -- an early return @{} would make the real attributes dead code.
    expect(getter).toMatch(/return\s*@\{\};/);
    const fallbackAt = getter.indexOf('return @{};');
    const textAt = getter.search(/attributedText|attributesAtIndex/);
    expect(textAt).toBeGreaterThan(-1);
    expect(textAt).toBeLessThan(fallbackAt);
    // The associated object is checked FIRST: React's last assigned value is
    // the one it will compare against, so a later real-field read would shadow
    // it. Order is load-bearing and so is being tested at all.
    const assignedAt = getter.search(/objc_getAssociatedObject/);
    expect(assignedAt).toBeGreaterThan(-1);
    expect(assignedAt).toBeLessThan(textAt);
    // defaultTextAttributes is the second fallback, and it is reachable ONLY
    // because the category is on RCTUITextField: it is declared on React's
    // subclass, never on NSTextField. That is one of the errors the
    // compile test above now catches, in the language the author could read.
    expect(getter).toMatch(/defaultTextAttributes/);
    expect(HEADER).toMatch(/typingAttributes/);
  });

  // The setter runs on every keystroke. If it writes into attributedText it
  // fights React over content React owns. RCTUITextView.mm:202-206 avoids the
  // same trap the same way this does -- by not applying the argument to the
  // field -- but it does NOT ignore the argument: it forwards
  // `[super setTypingAttributes:_defaultTextAttributes]`, a DIFFERENT value, to
  // stop NSTextView re-deriving its own. An earlier revision of this comment
  // said "ignoring its argument", which is false (REVIEWER-6). This stores the
  // argument, so React's value is what the next getter returns, and does not
  // touch text.
  it('stores the setter argument instead of rewriting the field text', () => {
    const setter = methodBody('setTypingAttributes:');
    expect(setter.length).toBeGreaterThan(0);
    expect(setter).not.toMatch(/setAttributedText|mutableString|setString:/);
    // The value has to land somewhere: an empty setter body satisfies the
    // no-side-effects assertion above while regressing typing attributes.
    expect(setter).toMatch(/objc_setAssociatedObject/);
    // REVIEWER-8: the ASSOCIATION POLICY is load-bearing and was untested.
    // OBJC_ASSOCIATION_RETAIN compiles clean and satisfies every assertion
    // above, so the suite went green on a setter that stores React's
    // attributes without copying them -- and React hands over a fresh
    // dictionary per keystroke, so a retained one is aliased into whatever
    // the field editor still holds. Name the policy, not just the function.
    expect(setter).toMatch(/OBJC_ASSOCIATION_COPY/);
    expect(setter).not.toMatch(/OBJC_ASSOCIATION_RETAIN/);
    // REVIEWER-7: OBJC_ASSOCIATION_COPY already copies. An explicit
    // `[typingAttributes copy]` in the argument double-copies on every
    // keystroke and reads as if the association did not copy.
    expect(setter).not.toMatch(/\[typingAttributes\s+copy\]/);
  });
});
