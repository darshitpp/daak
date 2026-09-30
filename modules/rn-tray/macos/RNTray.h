#import <React/RCTEventEmitter.h>

@class NSPopover;
@class NSStatusItem;

NS_ASSUME_NONNULL_BEGIN

@interface RNTray : RCTEventEmitter <RCTBridgeModule>

// RCT_EXPORT_MODULE registers the CLASS, so the bridge builds its OWN RNTray
// and the exported methods run on THAT instance, not on the singleton below.
// So the singleton is the single AppKit OWNER (status item, menu, popover) and
// the bridge instance is a thin forwarder that also has to be the event sink,
// because only an RCTEventEmitter with a bridge can emit DaakTraySelect.
//
// The popover lives HERE rather than in the window host for exactly that
// reason: two NSPopover ivars in two classes means setPopoverVisible:NO
// closes a popover nobody ever showed.
+ (instancetype)sharedInstance;
+ (nullable NSStatusItem *)statusItem;
- (void)adoptEmitter:(RNTray *)emitter;
- (void)setStatusItemTitle:(NSString *)title;
- (void)replaceMenuItems:(NSArray<NSDictionary *> *)items;
- (void)attachPopover:(NSPopover *)popover;
- (BOOL)hasPopover;
- (void)presentPopover;
- (void)dismissPopover;

@end

NS_ASSUME_NONNULL_END
