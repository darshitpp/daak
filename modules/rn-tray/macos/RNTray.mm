#import "RNTray.h"

#import <Cocoa/Cocoa.h>
#import <React/RCTEventEmitter.h>
#import <React/RCTUtils.h>

// The AppKit owner. The bridge's own RNTray is a different object (see
// RNTray.h), and it is the only one of the two with a bridge, so it is the only
// one that can emit DaakTraySelect. Hence the emitter ivar, handed over by the
// bridge instance's install().
//
// An extension, not an ivar block entry: a class extension has to precede the
// @implementation, and putting it after one is a hard compile error ('cannot
// declare class extension after class implementation' plus a missing '@end' for
// the unterminated @interface).
@interface RNTray ()
@property (nonatomic, weak, nullable) RNTray *emitter;
@end

@implementation RNTray {
  NSStatusItem *_statusItem;
  NSPopover *_popover;
  NSMenu *_menu;
  NSMenuItem *_expandItem;
}

RCT_EXPORT_MODULE(DaakTray)

+ (BOOL)requiresMainQueueSetup { return YES; }

// Every method below drives AppKit (NSStatusBar, NSMenu), so the module's
// queue IS the main queue. Without this, RCTEventEmitter declares no
// methodQueue, so the bridge synthesises a private background queue and the
// RCTAssertMainQueue calls become a Debug crash on the first install().
// Same one-liner as RCTAppState.mm / RCTDeviceInfo.mm.
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }

- (NSArray<NSString *> *)supportedEvents { return @[ @"DaakTraySelect" ]; }

// NOT `-install`: RCT_EXPORT_METHOD(install:reject:) already defines the
// `install` selector, and defining it twice in one @implementation is a
// compile error, not a warning.
+ (instancetype)sharedInstance {
  static RNTray *shared = nil;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    shared = [RNTray new];
  });
  return shared;
}

+ (NSStatusItem *)statusItem {
  return [self sharedInstance]->_statusItem;
}

- (void)installStatusItem {
  RCTAssertMainQueue();
  if (_statusItem != nil) {
    return;
  }
  _statusItem = [[NSStatusBar systemStatusBar]
      statusItemWithLength:NSSquareStatusItemLength];
  // MenuBarIcon is a template image in the app asset catalog. The system tints
  // it for the light bar, the dark bar, and the pressed state. The symbol is
  // the fallback for a host app that has no such image.
  NSImage *icon = [NSImage imageNamed:@"MenuBarIcon"];
  if (icon == nil) {
    icon = [NSImage imageWithSystemSymbolName:@"paperplane"
                     accessibilityDescription:@"Daak"];
  }
  [icon setTemplate:YES];  // dot syntax: `template` is a C++ keyword in Objective-C++
  icon.accessibilityDescription = @"Daak";
  _statusItem.button.image = icon;
  _menu = [[NSMenu alloc] initWithTitle:@"Daak"];
  // NSStatusItem.menu, not a target/action on the button. The system then owns
  // the click: it shows THIS menu on left AND right click, so the per-device Send
  // (the only send affordance that exists -- packages/ui Popover.tsx has none) is
  // one click away on either button, and there is no second route to it.
  //
  // It also kills the old bug outright: NSStatusItem.button is an AppKit-created
  // NSStatusBarButton, so casting it to a private NSStatusBarButton subclass and
  // sending it setOnLeftClick: could never have worked.
  _statusItem.menu = _menu;
}

- (void)adoptEmitter:(RNTray *)emitter {
  RCTAssertMainQueue();
  _emitter = emitter;
}

// The popover is attached by the window host, which is the only class that can
// reach the app's shared RCTRootViewFactory. Keeping the NSPopover here is what
// makes setPopoverVisible:NO close the popover that was actually shown.
- (void)attachPopover:(NSPopover *)popover {
  RCTAssertMainQueue();
  _popover = popover;
}

// The window host asks this before building a second popover: a status item can
// be clicked repeatedly and each click lands here, so without the check every
// click would allocate another NSPopover and re-attach it, orphaning the last
// one while the JS side still holds a reference to the FIRST one via
// setPopoverVisible.
- (BOOL)hasPopover {
  return _popover != nil;
}

- (void)presentPopover {
  RCTAssertMainQueue();
  // Both ivars are checked, not just the popover: setPopoverVisible:YES can
  // arrive before install() has created a status item, and sending a message to
  // a nil _statusItem returns a nil button, whose .bounds is a zero rect -- so
  // the popover would show anchored to nothing at the screen origin.
  if (_popover == nil || _statusItem == nil) {
    return;
  }
  if (_popover.isShown) {
    [_popover close];
    return;
  }
  [_popover showRelativeToRect:_statusItem.button.bounds
                        ofView:_statusItem.button
                 preferredEdge:NSRectEdgeMinY];
}

- (void)dismissPopover {
  RCTAssertMainQueue();
  [_popover close];
}

- (void)handleClick {
  RCTAssertMainQueue();
  // A notification, not a direct call into the window host: AppDelegate owns
  // the factory and the dashboard window, and RNTray must not need to know
  // about either. The observer in AppDelegate.mm is the one place both are
  // visible. The status item rides along as the notification object so the host
  // has an anchor even before attachPopover: has run.
  [[NSNotificationCenter defaultCenter] postNotificationName:@"DaakTrayClicked"
                                                      object:_statusItem];
}

// The popover, now that the STATUS ITEM click belongs to the system (it opens
// the menu). The button is permanently occupied, so the popover hangs off an
// expand item in that same menu. It posts the SAME DaakTrayClicked notification
// a user click used to post, so there is still exactly ONE entry point into the
// popover -- the AppDelegate observer -- rather than a second one living here.
// (The 'dashboard' menu id is NOT that route: it emits DaakTraySelect and JS
// opens the dashboard WINDOW.)
- (void)handleExpand:(id)sender {
  [self handleClick];
}

// A permanent expand item, kept out of the JS payload: the menu is rebuilt on
// every engine event, so the native side has to put it back or it flickers out
// of existence between two setMenu: calls.
//
// It goes BEFORE the last JS item, not after everything. buildTrayMenu always
// ends with 'Quit Daak', and appending after that put 'Show Peers' in the final
// slot -- so the bottom of the menu was no longer Quit, which is the one
// convention every macOS status menu follows. Inserting at numberOfItems - 1
// needs no knowledge of the JS payload, and MAX keeps it valid when the payload
// is empty.
- (void)installExpandItem {
  if (_expandItem != nil) {
    return;
  }
  _expandItem = [[NSMenuItem alloc] initWithTitle:@"Show Peers"
                                           action:@selector(handleExpand:)
                                    keyEquivalent:@""];
  _expandItem.target = self;
  _expandItem.enabled = YES;
  [_menu insertItem:[NSMenuItem separatorItem] atIndex:MAX(0, _menu.numberOfItems - 1)];
  [_menu insertItem:_expandItem atIndex:MAX(0, _menu.numberOfItems - 1)];
}

// The ACTION of every menu item, so this is what actually fires on click. It
// runs on the SINGLETON (replaceMenuItems: set target = self there), so the
// emit has to go through the emitter the bridge instance handed us -- the
// singleton has no bridge of its own.
// `menuItemSelected:` is the NSMenuDelegate callback and is never invoked for
// an item with a target/action, so emitting from it sent nothing.
- (void)handleMenuItem:(NSMenuItem *)sender {
  RCTAssertMainQueue();
  [_emitter sendEventWithName:@"DaakTraySelect" body:@{ @"id" : sender.representedObject ?: @"" }];
}

RCT_EXPORT_METHOD(install : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  // The bridge's own instance is the emitter; the singleton owns the AppKit.
  [[RNTray sharedInstance] adoptEmitter:self];
  [[RNTray sharedInstance] installStatusItem];
  resolve(nil);
}

RCT_EXPORT_METHOD(setTitle : (NSString *)title resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  RCTAssertMainQueue();
  [[RNTray sharedInstance] setStatusItemTitle:title];
  resolve(nil);
}

RCT_EXPORT_METHOD(setMenu : (NSString *)itemsJson resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  RCTAssertMainQueue();
  NSData *data = [itemsJson dataUsingEncoding:NSUTF8StringEncoding];
  NSArray<NSDictionary *> *items = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  [[RNTray sharedInstance] replaceMenuItems:items];
  resolve(nil);
}

- (void)setStatusItemTitle:(NSString *)title {
  RCTAssertMainQueue();
  _statusItem.button.toolTip = title;
}

- (void)replaceMenuItems:(NSArray<NSDictionary *> *)items {
  RCTAssertMainQueue();
  [_menu removeAllItems];
  for (NSUInteger i = 0; i < items.count; i++) {
    NSDictionary *item = items[i];
    // Skip a separator before the first element: it would render a leading,
    // orphaned divider whatever the payload says.
    if (i > 0 && [item[@"separatorBefore"] boolValue]) {
      [_menu addItem:[NSMenuItem separatorItem]];
    }
    NSMenuItem *menuItem = [[NSMenuItem alloc] initWithTitle:item[@"label"]
                                                     action:@selector(handleMenuItem:)
                                              keyEquivalent:@""];
    menuItem.target = self;
    menuItem.representedObject = item[@"id"];
    menuItem.enabled = [item[@"enabled"] boolValue];
    [_menu addItem:menuItem];
  }
  [self installExpandItem];
}

RCT_EXPORT_METHOD(setPopoverVisible : (BOOL)visible resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  RCTAssertMainQueue();
  RNTray *owner = [RNTray sharedInstance];
  if (visible) {
    // Same route as a status item click, so a JS-driven show and a user click
    // are the same code path. If no popover has been built yet (nothing has been
    // attached), the notification is what makes the window host build one --
    // toggling a nil popover here would silently do nothing, which is exactly
    // the BUG 3 failure mode the single-ivar rule exists to prevent.
    if (owner.hasPopover) {
      [owner presentPopover];
    } else {
      [owner handleClick];
    }
  } else {
    [owner dismissPopover];
  }
  resolve(nil);
}

@end
