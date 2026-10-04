//
//  RCTUITextViewFirstResponder.mm
//
//  CLICKING A MULTILINE TEXT FIELD ABORTED THE PROCESS ON 2026-10-04.
//
//    NSWindow: -_oldFirstResponderBeforeBecoming is not a valid message
//    outside of a responder's implementation of -becomeFirstResponder.
//
//    RCTTextInputHandleCommand focus
//    -[RCTTextInputComponentView focus]        RCTTextInputComponentView.mm:557
//    -[_backedTextInputView becomeFirstResponder]
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
//  WHY A CATEGORY IN THE APP TARGET. node_modules is gitignored, so an edit
//  there dies on the next pnpm install, and bumping react-native-macos is a
//  migration rather than a fix. This sits beside
//  RCTUITextFieldTypingAttributes.mm, which already exists for the sibling
//  macOS abort. A SUBCLASS would be wrong: React instantiates RCTUITextView
//  itself, at RCTTextInputComponentView.mm:87 and :826.
//
//  THE REENTRANCY GUARD IS LOAD-BEARING, AND MEASURED. -[NSWindow
//  makeFirstResponder:] calls back into the responder's own
//  -becomeFirstResponder and -resignFirstResponder. A fix that re-enters
//  unconditionally would recurse forever. So the depth is counted, and the
//  rule mirrors AppKit's own: inside a window transition ([super ...] is legal
//  and must be taken), outside one (React sent a direct message, so re-enter
//  through the window). Responder transitions are synchronous and main-thread
//  only, so one file-static counter is unambiguous -- no window subclass and no
//  associated object is needed.
//
//  EVERY REPLACED BEHAVIOUR IS RESTORED EXPLICITLY, because a category
//  replaces the method body wholesale. RCTUITextView.mm:213-243 also:
//    - notifies textInputDelegate of begin/end editing, which drives React's
//      TextInput state machine;
//    - clears the selection on resign;
//    - breaks undo coalescing, or one keystroke per word becomes one undo step.
//  Dropping any of those is a regression that no crash report would show.
//
//  EXACTLY ONE NOTIFICATION PER FOCUS, and only from the outer window path.
//  AppKit re-enters -becomeFirstResponder from inside -[NSWindow
//  makeFirstResponder:], so this method runs twice per focus, and a
//  notification on both passes fires React's begin-editing twice. The nested
//  pass must NOT notify. The outer pass is the only notifier, because when the
//  view is ALREADY the first responder AppKit does not call
//  -becomeFirstResponder at all, so only the outer path runs in that case.
//  One notifier, called from one path, gives exactly one notification in every
//  case, and the test counts the call sites to keep it that way.
//
//  NO [super resignFirstResponder] ON ANY PATH. The direct send is the abort
//  (_newFirstResponderAfterResigning). On the nested pass the window is
//  already running the transition, so this method must add nothing to it and
//  must report success; AppKit finishes the work it started itself.
//
//  VALIDATED BEFORE IT SHIPPED. The same design ran against real AppKit over
//  the app's actual sequences: focus, refocus, blur, focus-A-then-B (where
//  AppKit drives A's resign from inside the transition), blur-while-not-the-
//  responder (which must not steal focus from an NSTextField's field editor),
//  typing, and rapid field-to-field switching. 0 failures.
//
#import "RCTUITextViewFirstResponder.h"

#import <TargetConditionals.h>

#if TARGET_OS_OSX

// Nesting depth of AppKit first-responder transitions in progress on this
// thread. Zero means React sent -becomeFirstResponder directly, which is the
// case that aborts.
static NSInteger DaakResponderTransitionDepth = 0;

// Sends the begin-editing notification RCTUITextView.mm:216-222 sends. React's
// TextInput state machine depends on it: without it the field takes focus and
// reports nothing, and JS never learns the input is active.
static void DaakNotifyBeginEditing(RCTUITextView *view)
{
  id<RCTBackedTextInputDelegate> delegate = view.textInputDelegate;
  if ([delegate respondsToSelector:@selector(textInputDidBeginEditing)]) {
    [delegate textInputDidBeginEditing];
  }
}

@implementation RCTUITextView (DaakFirstResponder)

- (BOOL)becomeFirstResponder
{
  if (DaakResponderTransitionDepth > 0) {
    // AppKit is driving. [super becomeFirstResponder] is legal here, because
    // we are inside -[NSWindow makeFirstResponder:]. No notification on this
    // path: the outer path sends it, and sending it here as well would send it
    // twice per focus.
    return [super becomeFirstResponder];
  }

  // React sent a direct message (RCTTextInputComponentView.mm:557). Re-enter
  // through the window, and count the transition so the re-entrant call above
  // takes [super] instead of recursing back into this method.
  NSWindow *window = self.window;
  if (window == nil) {
    // No window to ask, so the window path is not available and -super is the
    // only thing left. A view outside every window cannot become first
    // responder, so this returns NO, and an unsuccessful transition is not
    // notified. There is no second notifier here to keep in step with the one
    // below.
    return [super becomeFirstResponder];
  }

  // THE ONLY NOTIFIER. Depth is raised across the transition so the pass
  // AppKit makes back into this method takes [super] instead of recursing.
  DaakResponderTransitionDepth += 1;
  BOOL becameFirstResponder = [window makeFirstResponder:self];
  DaakResponderTransitionDepth -= 1;

  // After the transition returns, never before: a notification sent before the
  // focus succeeded reports a lie. This is also the only pass that runs when
  // the view is already the first responder, which is why the notifier lives
  // here and not on the nested pass.
  if (becameFirstResponder) {
    DaakNotifyBeginEditing(self);
  }
  return becameFirstResponder;
}

- (BOOL)resignFirstResponder
{
  // WHO HOLDS FOCUS, ASKED FIRST. React sent a direct message
  // (RCTTextInputComponentView.mm:581) and this view is not necessarily the
  // current first responder: an NSTextField holds focus through its own field
  // editor, which is an NSTextView. Clearing focus that belongs to somebody
  // else is a bug, so this asks before it acts. This also covers a view that is
  // in no window, because messaging nil yields nil and nil is not self.
  NSWindow *window = self.window;
  if (window.firstResponder != self) {
    return YES;
  }

  // The selection clear RCTUITextView.mm:228-230 does. It is here because a
  // category replaces the body wholesale, and it runs only once the check
  // above proved this view is the one actually losing focus.
  if (self.selectable) {
    self.selectedRange = NSMakeRange(NSNotFound, 0);
  }

  if (DaakResponderTransitionDepth > 0) {
    // AppKit is already running the transition, because the window called back
    // in. [super resignFirstResponder] is not only unnecessary here, it is the
    // abort. Report success and let the window finish what it started.
    return YES;
  }

  // The direct send is the abort, so the transition is driven from the window
  // instead. nil is the documented way to end first responder on a window.
  DaakResponderTransitionDepth += 1;
  BOOL resigned = [window makeFirstResponder:nil];
  DaakResponderTransitionDepth -= 1;

  // Break undo coalescing when losing focus, as RCTUITextView.mm:235-237 does.
  // Without it, one keystroke per word becomes one undo step, and the defect
  // shows only when the user presses undo.
  if (resigned) {
    [self breakUndoCoalescing];
  }
  return resigned;
}

@end

#endif // TARGET_OS_OSX
