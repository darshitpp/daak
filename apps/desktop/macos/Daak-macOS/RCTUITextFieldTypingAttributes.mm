#import "RCTUITextFieldTypingAttributes.h"

#import <TargetConditionals.h>

#if TARGET_OS_OSX

#import <objc/runtime.h>

// A category cannot add ivars, so React's last-assigned value is parked as an
// associated object. OBJC_ASSOCIATION_OWNER is irrelevant here: the field owns
// the key and outlives nothing that outlives itself.
static const void *DaakTypingAttributesKey = &DaakTypingAttributesKey;

@implementation RCTUITextField (DaakTypingAttributes)

- (NSDictionary<NSAttributedStringKey, id> *)typingAttributes
{
  // React's own value first, always. This is the same dictionary
  // _updateTypingAttributes last handed us (:817), so reading it back is the
  // only answer that compares equal to what React is about to check against.
  NSDictionary<NSAttributedStringKey, id> *assigned = objc_getAssociatedObject(self, DaakTypingAttributesKey);
  if (assigned != nil) {
    return assigned;
  }

  // Nothing assigned yet -- the :92 read in init, on a field React has not
  // typed into. Sample the attributes just left of the caret, which is the
  // same point RCTTextInputComponentView.mm:812-818 samples, so the answer
  // still describes what would actually be typed.
  NSAttributedString *text = self.attributedText;
  if (text.length > 0) {
    // Bracketed, not dot-syntax, and that is load-bearing rather than style:
    // RCTBackedTextInputViewProtocol.h:78 marks -setSelectedTextRange:
    // NS_UNAVAILABLE (a direct write would break the field editor's delegate
    // notifications). That UNAVAILABLE SETTER poisons the whole property, so
    // `self.selectedTextRange` does not compile either -- dot syntax on an
    // ObjC property is read as get+set. The bracketed getter is fine, and it is
    // exactly how RCTTextInputComponentView.mm:812 reads it.
    NSUInteger location = [self selectedTextRange].location;
    NSUInteger samplePoint = (location == NSNotFound || location == 0) ? 0 : location - 1;
    NSDictionary<NSAttributedStringKey, id> *attributes = [text attributesAtIndex:samplePoint effectiveRange:NULL];
    if (attributes != nil) {
      return attributes;
    }
  }

  NSDictionary<NSAttributedStringKey, id> *defaults = self.defaultTextAttributes;
  if (defaults != nil) {
    return defaults;
  }

  // Last resort, and the reason the header says non-null: empty is non-nil and
  // reads to RCTIsAttributedStringEffectivelySame as no insensitive attributes.
  //
  // There is deliberately no `attributes` fallback after this one. NSTextField
  // has no such property -- zero declarations in the AppKit SDK -- and neither
  // does RCTUITextField, so a message send to it does not compile; that was one
  // of the compile errors the previous revision shipped. RCTBackedTextInputView-
  // ViewProtocol.h:90 routes around it in the same direction, "use
  // `attributedText.string` instead", and the read above already is that.
  return @{};
}

- (void)setTypingAttributes:(NSDictionary<NSAttributedStringKey, id> *)typingAttributes
{
  // Deliberately does NOT touch attributedText, and deliberately does NOT
  // ignore the argument. RCTUITextView.mm:202-206, the only implementation of
  // this selector upstream, dodges the same trap by forwarding a DIFFERENT
  // value -- `[super setTypingAttributes:_defaultTextAttributes]`, commented
  // "Prevent NSTextView from changing its own typing attributes out from under
  // us" -- not by dropping what it was handed. Writing React's value into the
  // field here would fight React for text React owns, on every keystroke,
  // because _updateTypingAttributes assigns on each one.
  //
  // OBJC_ASSOCIATION_COPY already copies, so the value is stored as handed over
  // instead of `[typingAttributes copy]`-ed first: React's own caller at :817
  // hands over a fresh dictionary each time, and the second copy buys nothing.
  objc_setAssociatedObject(self, DaakTypingAttributesKey, typingAttributes, OBJC_ASSOCIATION_COPY);
}

@end

#endif // TARGET_OS_OSX
