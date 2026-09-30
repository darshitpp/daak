#import "RNWindowHost.h"

#import <Cocoa/Cocoa.h>
#import <React/RCTUtils.h>
#import "RNTray.h"

// RCTRootViewFactory lives in the React-RCTAppDelegate pod, which DaakTray does
// NOT depend on -- and adding that dependency is not this task's call. So the
// class is forward-declared and the one method used is declared here, matching
// RCTRootViewFactory.h exactly:
//   - (RCTPlatformView *)viewWithModuleName:(NSString *)moduleName
//                         initialProperties:(NSDictionary *)initialProperties;
// RCTPlatformView is NSView on macOS (React/RCTUIKit.h), so the return type is
// spelled as NSView and no RCTUIKit.h import is needed here either.
@interface RCTRootViewFactory : NSObject
- (NSView *)viewWithModuleName:(NSString *)moduleName
           initialProperties:(NSDictionary *)initialProperties;
@end

@implementation RNWindowHost {
  __weak RCTRootViewFactory *_factory;
  __weak NSWindow *_dashboard;
}

+ (instancetype)shared {
  static RNWindowHost *shared = nil;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    shared = [RNWindowHost new];
  });
  return shared;
}

// Exported host-scoped, not as a bare platform name; see RNWindowHost.h.
RCT_EXPORT_MODULE(DaakWindowHost)

// Drives AppKit and is called from RCT_EXPORT_METHOD, so the bridge method
// queue must be the main queue for the same reason RNTray.mm's is: without it
// every RCTAssertMainQueue below is a Debug abort.
+ (BOOL)requiresMainQueueSetup { return YES; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }

- (void)adoptRootViewFactory:(RCTRootViewFactory *)factory {
  RCTAssertMainQueue();
  _factory = factory;
}

- (void)adoptDashboardWindow:(NSWindow *)window {
  RCTAssertMainQueue();
  _dashboard = window;
}

// RCTRootView has NO -initWithModuleName:. Its initializers are
// initWithFrame:bridge:moduleName:initialProperties: (designated),
// initWithBridge:moduleName:initialProperties:, and
// initWithBundleURL:moduleName:initialProperties:launchOptions:.
//
// The factory is the right handle, not -bridge, for two reasons. First,
// -viewWithModuleName: calls createBridgeIfNeeded, so it is the only one of the
// three that works on a bridgeless (new-arch) build, where bridge is nil and
// all the work happens on reactHost instead. Second, it also injects the
// concurrentRoot initial prop via updateInitialProps, so a second root built
// by hand would disagree with the first about React 18 semantics.
//
// It also cannot be initWithBundleURL: twice: that evaluates the bundle per
// root, i.e. two runtimes, two engines, two daakd connections -- exactly what
// apps/desktop/index.js's "one engine for the whole process" forbids.
//
// There is deliberately NO presentPopoverAsync export: a JS-callable
// "present the popover" would be a THIRD route to the same NSPopover, beside
// the status item click and setPopoverVisible, and two of the three would
// eventually disagree about which one is showing.
- (NSView *)rootViewForModule:(NSString *)moduleName {
  RCTRootViewFactory *factory = _factory;
  if (factory == nil) {
    return nil;
  }
  return [factory viewWithModuleName:moduleName initialProperties:nil];
}

- (void)presentPopoverFrom:(NSStatusItem *)statusItem {
  RCTAssertMainQueue();
  RNTray *tray = [RNTray sharedInstance];
  // An existing popover is toggled, not replaced. Rebuilding it per click would
  // allocate a new RCTRootView (and a new mounted React tree) every time, and
  // the RNTray ivar would end up pointing at the newest one while the tree the
  // user is looking at is an older one.
  if ([tray hasPopover]) {
    [tray presentPopover];
    return;
  }
  NSStatusItem *item = statusItem ?: [RNTray statusItem];
  if (item == nil) {
    // No icon means no anchor, and an NSPopover with no anchor cannot be shown.
    // install() has not run yet; the next tray click will work.
    return;
  }
  NSView *rootView = [self rootViewForModule:@"DaakPopover"];
  if (rootView == nil) {
    return;
  }
  NSPopover *popover = [[NSPopover alloc] init];
  popover.contentSize = NSMakeSize(360, 440);
  popover.behavior = NSPopoverBehaviorTransient;
  NSViewController *controller = [NSViewController new];
  controller.view = rootView;
  popover.contentViewController = controller;

  // The popover is handed to the tray, which owns the status item it is
  // anchored to and is the class setPopoverVisible: acts on.
  [tray attachPopover:popover];
  [popover showRelativeToRect:item.button.bounds
                       ofView:item.button
                preferredEdge:NSRectEdgeMinY];
}

- (void)openDashboard {
  RCTAssertMainQueue();
  NSWindow *window = _dashboard;
  if (window == nil) {
    return;
  }
  [window makeKeyAndOrderFront:nil];
  // An LSUIElement app has no Dock icon, so nothing brings it forward on its
  // own; without this the dashboard opens BEHIND whatever the user is in.
  [NSApp activateIgnoringOtherApps:YES];
}

- (void)closePopover {
  RCTAssertMainQueue();
  [[RNTray sharedInstance] dismissPopover];
}

RCT_EXPORT_METHOD(openDashboard : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  // [RNWindowHost shared], not self: RCT_EXPORT_MODULE registers the CLASS, so
  // this method body runs on the BRIDGE's own instance, whose _dashboard/
  // _factory are nil forever -- only adoptDashboardWindow: ever set them, and
  // it is called on the singleton (AppDelegate.mm). Forwarding to the singleton
  // is the same shape RNTray.mm's exports already use.
  [[RNWindowHost shared] openDashboard];
  resolve(nil);
}

RCT_EXPORT_METHOD(closePopover : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  [[RNWindowHost shared] closePopover];
  resolve(nil);
}

@end
