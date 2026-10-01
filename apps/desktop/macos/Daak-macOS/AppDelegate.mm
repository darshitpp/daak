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

  // Menu-bar app: LSUIElement in Info.plist means there is no Dock icon, and
  // the dashboard must not appear at launch. It is ordered in on demand. The
  // root view stays alive inside the window, because that is what shares the
  // bridge with the popover -- orderOut hides, it does not tear down.
  self.window.title = @"Daak";
  [self.window orderOut:nil];

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
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
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
