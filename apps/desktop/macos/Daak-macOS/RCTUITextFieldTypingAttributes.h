//
//  RCTBackedTextInputViewProtocol.h:63 declares `typingAttributes` for every
//  backed text input, and RCTTextInputComponentView.mm sends the selector at
//  two sites (init copies it at :92, _updateTypingAttributes assigns it at
//  :817).
//
//  In react-native-macos 0.76.5 only the MULTILINE backed view implements it
//  (RCTUITextView.mm:202, an NSTextView). The SINGLE-LINE backed view is
//  RCTUITextField, an NSTextField subclass, and neither NSTextField nor
//  RCTUITextField implements it -- so mounting any single-line TextInput
//  terminates the app:
//
//    -[RCTUITextField typingAttributes]: unrecognized selector
//
//  The category is on RCTUITextField, NOT on NSTextField, and that is the only
//  place it can go. The states the getter reads -- attributedText,
//  selectedTextRange, defaultTextAttributes and (in the old revision) the
//  nonexistent `attributes` -- are declared on React's OWN SUBCLASS, not on
//  NSTextField: attributedText and defaultTextAttributes on RCTUITextField.h
//  (the TARGET_OS_OSX block), selectedTextRange on the protocol RCTUITextField
//  adopts (RCTBackedTextInputViewProtocol.h). A category cannot see a
//  subclass's declarations. A category on NSTextField produces several "no
//  visible @interface" errors and does not build; that is why this header
//  imports React's RCTUITextField.h and why a test compiles the .mm.
//
//  RCTUISecureTextField, the sibling NSSecureTextField subclass React also
//  builds, does NOT get the category. It is unreachable from
//  RCTTextInputComponentView on macOS: that view constructs RCTUITextField
//  directly at :88, :241-242 (`secureTextEntry` is iOS-only), and :826
//  constructs RCTUITextView unconditionally. The old path
//  (RCTSinglelineTextInputView.mm:69) is the non-Fabric one this app does not
//  use. Verified against libReact-RCTText.a, which exports BOTH class names --
//  so nothing at link time can substitute one for the other.
//
//  The category lives in the app target, not node_modules: node_modules is
//  gitignored, so a patch there dies on the next pnpm install, and bumping
//  react-native-macos is a migration rather than a fix.
//
#import <TargetConditionals.h>

#if TARGET_OS_OSX

#import <React/RCTUITextField.h>

NS_ASSUME_NONNULL_BEGIN

@interface RCTUITextField (DaakTypingAttributes)

// Both accessors are declared by hand rather than as a @property: a category
// cannot add ivars, and a declared property would ask the compiler to
// synthesize storage on a class that has none.
//
// Non-null on purpose. The protocol declares it nullable because the
// multiline view's is, but React copies the result in init and compares it
// later; nil there is either a crash or a text diff that never matches. The
// implementation answers with an empty dictionary when nothing better is
// available.
- (NSDictionary<NSAttributedStringKey, id> *)typingAttributes;
- (void)setTypingAttributes:(NSDictionary<NSAttributedStringKey, id> *)typingAttributes;

@end

NS_ASSUME_NONNULL_END

#endif // TARGET_OS_OSX
