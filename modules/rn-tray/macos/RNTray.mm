#import "RNTray.h"

#import <Cocoa/Cocoa.h>
#import <React/RCTEventEmitter.h>
#import <React/RCTUtils.h>

@implementation RNTray {
  NSStatusItem *_statusItem;
  NSPopover *_popover;
  NSMenu *_menu;
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
- (void)installStatusItem {
  RCTAssertMainQueue();
  if (_statusItem != nil) {
    return;
  }
  _statusItem = [[NSStatusBar systemStatusBar]
      statusItemWithLength:NSSquareStatusItemLength];
  NSImage *icon = [NSImage imageWithSystemSymbolName:@"paperplane"
                            accessibilityDescription:@"Daak"];
  _statusItem.button.image = icon;
  _statusItem.button.target = self;
  _statusItem.button.action = @selector(handleClick);

  _menu = [[NSMenu alloc] initWithTitle:@"Daak"];
}

- (void)handleClick {
  RCTAssertMainQueue();
  if (_menu.numberOfItems > 0) {
    [_statusItem popUpStatusItemMenu:_menu];
  }
}

// The ACTION of every menu item, so this is what actually fires on click.
// `menuItemSelected:` is the NSMenuDelegate callback and is never invoked for
// an item with a target/action, so emitting from it sent nothing.
- (void)handleMenuItem:(NSMenuItem *)sender {
  RCTAssertMainQueue();
  [self sendEventWithName:@"DaakTraySelect" body:@{ @"id" : sender.representedObject ?: @"" }];
}

RCT_EXPORT_METHOD(install : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  [self installStatusItem];
  resolve(nil);
}

RCT_EXPORT_METHOD(setTitle : (NSString *)title resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  RCTAssertMainQueue();
  _statusItem.button.toolTip = title;
  resolve(nil);
}

RCT_EXPORT_METHOD(setMenu : (NSString *)itemsJson resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  RCTAssertMainQueue();
  NSData *data = [itemsJson dataUsingEncoding:NSUTF8StringEncoding];
  NSArray<NSDictionary *> *items = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
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
  resolve(nil);
}

RCT_EXPORT_METHOD(setPopoverVisible : (BOOL)visible resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  RCTAssertMainQueue();
  if (visible) {
    [_statusItem.button performClick:nil];
  } else {
    [_popover close];
  }
  resolve(nil);
}

@end
