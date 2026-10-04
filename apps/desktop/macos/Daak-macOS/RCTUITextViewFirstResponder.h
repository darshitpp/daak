//
//  CLICKING A MULTILINE TEXT FIELD ABORTED THE PROCESS ON 2026-10-04.
//
//    NSWindow: -_oldFirstResponderBeforeBecoming is not a valid message
//    outside of a responder's implementation of -becomeFirstResponder.
//
//  THE CAUSE, MEASURED RATHER THAN ASSUMED. A standalone AppKit harness varied
//  one variable at a time and measured this table:
//
//    [NSTextView becomeFirstResponder]           RAISES  (isKey=1 AND isKey=0)
//    [[NSWindow makeFirstResponder:] view]       ok
//    [NSTextField becomeFirstResponder]          ok
//    [NSTextView resignFirstResponder]           RAISES  (_newFirstResponderAfterResigning)
//
//  Three things follow, and all three were checked against the running app:
//
//   1. It is NOT a key-window problem. It raised identically with the window
//      key and with it ordered out. A key-window subclass, a change to
//      -orderOut, and a change to the activation order were each guesses, and
//      the first one was tried and discarded.
//   2. AppKit allows a text view to take or drop first responder ONLY from
//      inside -[NSWindow makeFirstResponder:]. react-native-macos sends the
//      message directly at RCTTextInputComponentView.mm:557 and :581. Correct
//      for iOS; on macOS it aborts.
//   3. Plain NSTextView raises too, so RCTUITextView's -becomeFirstResponder
//      override (RCTUITextView.mm:213) is the MESSENGER, not the cause. A plain
//      NSTextField does not raise, which is why every single-line input mounted
//      -- the Settings rename box and the onboarding name box included -- and
//      only the MULTILINE inputs killed the app: SendScreen.tsx:170 and
//      ComposerBar.tsx:16.
//
//  The category is on RCTUITextView, NOT on NSTextView, and that is the only
//  place it can go. React constructs RCTUITextView itself when props.multiline
//  is true (RCTTextInputComponentView.mm:87 and :826), so a subclass would never
//  be instantiated. A category on NSTextView cannot see textInputDelegate,
//  which is declared on React's OWN SUBCLASS (RCTUITextView.h) and not on
//  NSTextView; without this import the category sees only the AppKit interface
//  and the delegate send does not compile. A category cannot add ivars, which
//  is why the reentrancy depth is a file-static counter in the .mm and not a
//  property here.
//
//  The category lives in the app target, not node_modules: node_modules is
//  gitignored, so a patch there dies on the next pnpm install, and bumping
//  react-native-macos is a migration rather than a fix. It sits beside
//  RCTUITextFieldTypingAttributes.h, which exists for the sibling macOS abort.
//
//  Both accessors below override methods React already implements
//  (RCTUITextView.mm:213-243), so this header declares no new member: a
//  declaration here would only be a promise that the category keeps. The .mm
//  restores each behaviour it replaces, because a category replaces the method
//  body wholesale.
//
#import <TargetConditionals.h>

#if TARGET_OS_OSX

#import <React/RCTUITextView.h>

@interface RCTUITextView (DaakFirstResponder)

@end

#endif // TARGET_OS_OSX
