#import "AppDelegate.h"

#import <React/RCTBundleURLProvider.h>
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
#if DEBUG
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
#else
  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
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
