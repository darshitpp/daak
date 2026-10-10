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
  // STRONG. Measured, not assumed. RCTAppDelegate creates this window in CODE
  // (react-native-macos 0.76, RCTAppDelegate.mm loadReactNativeWindow:, the
  // TARGET_OS_OSX branch) and AppDelegate.mm hands it here and then orderOuts it.
  // RCTAppDelegate.h also declares @property(strong) window, so the delegate
  // keeps it alive and __weak was NOT the cause of the lost focus on 2026-10-04.
  // A probe in this file showed the adopted window non-nil, and
  // makeKeyAndOrderFront left it visible=1 onscreen=1. The window was never
  // missing. The app was never frontmost.
  //
  // Kept strong anyway, because the delegate is the only other owner and a
  // second weak link would make this object's behaviour depend on a property
  // declared in another header. RNTray.mm holds _statusItem and _popover as
  // strong ivars for the same reason.
  NSWindow *_dashboard;
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
  // 320 points, as in the design (macos-menubar.html). The React root has the same width.
  popover.contentSize = NSMakeSize(320, 440);
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
  // THE POLICY IS THE FIX. Under Prohibited an app may not create windows and
  // may not be activated, so -activateIgnoringOtherApps: is refused and
  // makeKeyAndOrderFront leaves the window behind every other window.
  // CoreGraphics reported the window on screen the whole time (layer 0,
  // onscreen=1, alpha=1, 1280x748). That is why the defect looked like a dead
  // menu item instead of a focus bug.
  //
  // BOTH CALLS EXISTED BEFORE THIS CHANGE, so the line order was NOT the
  // defect. -activateIgnoringOtherApps: was already called at the old HEAD, on
  // the line AFTER makeKeyAndOrderFront. It was refused under Prohibited in
  // BOTH orders, because the policy, not the order, decides. The order below is
  // activate-then-order only because activating first is the conventional
  // sequence. Apple documents NO ordering requirement between the two calls,
  // and none is claimed here.
  //
  // DISCREPANCY, RECORDED, NOT RESOLVED. The old Info.plist set LSUIElement=1,
  // and NSRunningApplication.h maps LSUIElement=1 to
  // NSApplicationActivationPolicyAccessory and maps Prohibited to
  // LSBackgroundOnly=1. The live process still measured activationPolicy=2 with
  // LSUIElement=1 set and no LSBackgroundOnly present. The measured value and
  // the documented value disagree. The measurement is the fact here. The
  // documented cause does not explain it, and no code change follows from this
  // comment.
  //
  // AppDelegate.mm sets Regular on the next main-queue turn after launch, so
  // the guard below is FALSE on the normal path. It is defence, not the live
  // path: it repairs the policy if AppKit ever reinstalls Prohibited, and it
  // costs one comparison.
  //
  // Regular, not Accessory: the app is a NORMAL app with a Dock icon, a Cmd-Tab
  // entry, and the standard app menu bar, and the status item stays beside
  // them. The enum runs Regular 0, Accessory 1, Prohibited 2. The repair only
  // has to move the process OFF Prohibited, so it restores Regular.
  if (NSApp.activationPolicy == NSApplicationActivationPolicyProhibited) {
    // -setActivationPolicy: returns BOOL and the value is discarded on purpose.
    // A refused change reports NO here, and the activation call below then
    // refuses too. No error handling belongs in this method.
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
  }
  // CORRECT TODAY. -activateIgnoringOtherApps: carries API_DEPRECATED with
  // API_TO_BE_DEPRECATED, and the header names -activate as its replacement.
  // -activate needs macOS 14 and the Podfile floor here is macOS 11.0, so
  // -activate is not callable without raising the floor. Until that happens,
  // -activateIgnoringOtherApps: is the correct call.
  [NSApp activateIgnoringOtherApps:YES];
  [window makeKeyAndOrderFront:nil];
}

- (void)closePopover {
  RCTAssertMainQueue();
  [[RNTray sharedInstance] dismissPopover];
}

// [NSApp terminate:nil] and nothing else. The app menu's Quit Daak item in
// Main.storyboard already sends this exact selector to the First Responder, so
// this is the SAME termination the user gets from the app menu -- it is not a
// second mechanism that could behave differently, and it is not a new Quit menu
// item. terminate: is not restricted by the activation policy: the SDK header
// (NSApplication.h) declares it with no API_AVAILABLE note and no policy note,
// and AppDelegate.mm sets NSApplicationActivationPolicyRegular on the next
// main-queue turn after launch, so the process runs under Regular. Whether the
// app menu Quit has been clicked in this process is NOT measured here; the brief
// reported that it works. Nothing in this file depends on that report.
//
// The policy is NOT repaired here. Regular is the normal app shape, and the app
// keeps it while it terminates; openDashboard's repair is about activation, not
// about quitting: a process under Prohibited cannot show a window, but it can
// still exit. Setting the policy from here would put one more AppKit call in
// the last moments of the process and could only make the termination less
// like the one the app menu already performs.
//
// No -applicationShouldTerminate: hook is implemented, in this file or in
// AppDelegate.mm, so nothing in the chain can answer NSTerminateCancel and
// terminate: exits the run loop.
- (void)quitApp {
  RCTAssertMainQueue();
  [NSApp terminate:nil];
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

RCT_EXPORT_METHOD(quitApp : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  [[RNWindowHost shared] quitApp];
  // resolve(nil) runs only if terminate: is refused, because the process is
  // gone otherwise. That is fine: the promise exists so the JS wrapper has the
  // same shape as openDashboard and closePopover, not so it can report anything.
  resolve(nil);
}

@end
