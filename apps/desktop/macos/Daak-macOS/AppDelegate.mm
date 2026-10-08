#import "AppDelegate.h"

#import <Carbon/Carbon.h>
#import <React/RCTBundleURLProvider.h>
#import <React/RCTLinkingManager.h>
#import <RNWindowHost.h>

@implementation AppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification
{
  // "Daak" was the generated name and matched NO AppRegistry key, so the shell
  // launched and rendered no root at all. Only DaakPopover and DaakDashboard
  // are registered (apps/desktop/index.js).
  self.moduleName = @"DaakDashboard";
  // You can add your custom initial props in the dictionary below.
  // They will be passed down to the ViewController used by React Native.
  self.initialProps = @{};

  [super applicationDidFinishLaunching:notification];

  // Normal app: Info.plist has no LSUIElement, so the app has a Dock icon, a
  // Cmd-Tab entry, and the standard app menu bar. The dashboard must not appear
  // at launch. It is ordered in on demand. The menu-bar status item stays
  // beside the normal app surfaces. The root view stays alive inside the
  // window, because that is what shares the bridge with the popover -- orderOut
  // hides, it does not tear down.
  self.window.title = @"Daak";
  [self.window orderOut:nil];

  // ACTIVATION AFTER LAUNCH, not on the first click. The live process measured
  // NSApplicationActivationPolicyProhibited (value 2) on 2026-10-04. Under
  // Prohibited an app may not create windows and may not be activated, so
  // -activateIgnoringOtherApps: is refused and the dashboard opens BEHIND every
  // other window. The window was on screen the whole time, so the failure
  // looked like a dead tray item.
  //
  // WHY THE PROCESS SAT ON 2 IS NOT DOCUMENTED, AND NO CLAIM IS MADE HERE. The
  // old Info.plist set LSUIElement=1, which NSRunningApplication.h maps to
  // Accessory, and Prohibited comes from LSBackgroundOnly=1, which was not set.
  // The measured value and the documented value disagree, and the reason is
  // recorded as unknown. What is measured is the value 2 and the window that
  // will not come forward while it holds.
  //
  // Not on the first click: the click that reaches openDashboard comes from the
  // status item, and the status item exists because the app is already running.
  // Measured: the policy was still 2 at that moment, the switch to Accessory
  // did run, and the app still ended up frontmost=false.
  //
  // Not in the body of this method either. A direct call in the launch method
  // measured as lost: the value read back as 1 on the line right after the
  // call, and the value read back as 2 from a later attach. So something overwrote
  // it AFTER the delegate line ran. dispatch_async moves the call to a later
  // main-queue turn, and a clean relaunch then measured activationPolicy=1.
  //
  // HONEST LIMIT. dispatch_async is a queue, not a barrier. It proves the block
  // runs later on the main thread. It does NOT prove the block runs after every
  // AppKit setup step, because AppKit is closed source and no header declares
  // when it installs Prohibited. So "the next main-queue turn is late enough"
  // is a MEASURED FACT on this host and an ASSUMPTION everywhere else. If a
  // future macOS moves the overwrite later, this call loses and the fallback in
  // RNWindowHost openDashboard repairs the policy on the next click.
  //
  // Regular, not Accessory. The app is a NORMAL app: a Dock icon, a Cmd-Tab
  // entry, and the standard app menu bar. Regular gives that shape. The
  // menu-bar status item stays under Regular.
  dispatch_async(dispatch_get_main_queue(), ^{
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
  });

  // The dashboard root above was created by this delegate's rootViewFactory.
  // Hand the SAME factory AND the SAME window to the window host: the popover
  // root comes out of the same bridge, and openDashboard just orders in the
  // window that is already hosting the dashboard root. A second RCTBridge would
  // be a second JS runtime and a second daakd connection (apps/desktop/index.js:
  // one engine, whole process), and a second window would be a second copy of
  // the whole dashboard.
  [[RNWindowHost shared] adoptRootViewFactory:self.rootViewFactory];
  [[RNWindowHost shared] adoptDashboardWindow:self.window];

  // A status item owns the popover; RNTray installs the icon and posts this
  // notification on click. The observer has to be registered HERE, not in the
  // window host: this delegate is the only object that holds both the
  // rootViewFactory (a React-RCTAppDelegate type the tray pod does not link) and
  // the dashboard window, and the host is inert until it is handed them.
  //
  // The note object is the NSStatusItem, so the host gets its anchor directly
  // instead of having to reach back into the tray for one.
  [[NSNotificationCenter defaultCenter] addObserverForName:@"DaakTrayClicked"
                                                    object:nil
                                                     queue:[NSOperationQueue mainQueue]
                                                usingBlock:^(NSNotification *note) {
    [[RNWindowHost shared] presentPopoverFrom:(NSStatusItem *)note.object];
  }];
}

- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
{
  return [self bundleURL];
}

// The dashboard window is ordered out at launch, so a click on the Dock icon or
// a selection through Cmd-Tab must bring it back. Without this handler the Dock
// icon of the NORMAL app does nothing. AppKit calls this when the app is
// reopened and no window is visible.
- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender hasVisibleWindows:(BOOL)flag
{
  [[RNWindowHost shared] openDashboard];
  return YES;
}

// RCTAppDelegate on react-native-macos 0.76 asks the SUBCLASS for bundleURL,
// and raises "Subclasses must implement a valid getBundleURL method" when it
// is absent -- so the app could not load a bundle at all, from Metro or from a
// release .jsbundle, and defining only sourceURLForBridge above was not enough.
// BOTH stay: RCTBridge.mm's -setUp and RCTRootViewFactory call
// sourceURLForBridge:, and the base RCTAppDelegate raises for it too, so both
// must be answered. The body lives once, in bundleURL.
- (NSURL *)bundleURL
{
#if DEBUG
  // The port has to be written HERE, because the provider will not supply it.
  // RCTBundleURLProvider appends its own default (RCT_METRO_PORT) to any
  // location that has no colon in it, so leaving jsLocation unset silently
  // yields the shared default port -- the one apps/mobile uses. A leftover
  // desktop packager on that port can then serve the desktop bundle to a
  // phone or an emulator, which dies on TurboModuleRegistry.getEnforcing(
  // 'DaakSystemNotify') -- an error naming a module rather than the port.
  //
  // Set ONLY when unset: an unconditional write would clobber a location a
  // developer configured by other means, and would rewrite NSUserDefaults and
  // post the provider-updated notification on every bundleURL call, i.e. a
  // packager reconnect on every reload.
  //
  // The host stays localhost on purpose -- nothing here may hardcode a LAN
  // address. The colon is load-bearing: it is what marks the port as already
  // present, so the provider stops appending its default.
  //
  // The literal below must equal the --port in BOTH npm scripts; those are the
  // only two places the number is written, and test/metro-port.spec.ts reads
  // the digits back out of package.json and fails if they drift.
  RCTBundleURLProvider *provider = [RCTBundleURLProvider sharedSettings];
  if (provider.jsLocation == nil) {
    provider.jsLocation = @"localhost:8082";
  }
  return [provider jsBundleURLForBundleRoot:@"index"];
#else
  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}

// daak:// links (RNDirectShare's Share menu, and any other app) arrive here.
// macOS has no per-app openURL callback with a usable signature beyond the Apple
// event this delegate already implements, and react-native-macos already OWNS
// URL delivery: RCTLinkingManager stores a cold-launch initialURL and posts
// RCTOpenURLNotification, which it forwards to JS as the `url` event. Reusing
// that is the whole point -- a second native emitter would be invisible to
// JS Linking.getInitialURL() / Linking.addEventListener('url'), which is where
// apps/desktop/index.js reads the route from.
- (void)application:(NSApplication *)application openURLs:(NSArray<NSURL *> *)urls
{
  for (NSURL *url in urls) {
    NSString *absolute = [url absoluteString];
    if (absolute == nil) {
      continue;
    }
    // The same descriptor shape the Finder 'open location' / mail client kAEGetURL
    // event carries, and the only one RCTLinkingManager knows how to read: it
    // takes the string out of keyDirectObject. Handing it anything else would
    // post a notification with a nil URL.
    NSAppleEventDescriptor *event =
        [[NSAppleEventDescriptor alloc] initWithEventClass:kInternetEventClass
                                                 eventID:kAEGetURL
                                          targetDescriptor:nil
                                                  returnID:kAutoGenerateReturnID
                                             transactionID:kAnyTransactionID];
    [event setParamDescriptor:[NSAppleEventDescriptor descriptorWithString:absolute]
                  forKeyword:keyDirectObject];
    [RCTLinkingManager getUrlEventHandler:event withReplyEvent:nil];
  }
}

/// This method controls whether the `concurrentRoot`feature of React18 is turned on or off.
///
/// @see: https://reactjs.org/blog/2022/03/29/react-v18.html
/// @note: This requires to be rendering on Fabric (i.e. on the New Architecture).
/// @return: `true` if the `concurrentRoot` feature is enabled. Otherwise, it returns `false`.
- (BOOL)concurrentRootEnabled
{
#ifdef RN_FABRIC_ENABLED
  return true;
#else
  return false;
#endif
}

@end
