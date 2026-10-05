#import <React/RCTBridgeModule.h>

@class RCTRootViewFactory;
@class NSWindow;
@class NSStatusItem;

NS_ASSUME_NONNULL_BEGIN

/**
 * Hosts the two React roots the menu-bar app shows: the popover and the
 * dashboard. Both come out of ONE RCTRootViewFactory, so both run in the same
 * JS runtime and therefore share the single DaemonClientEngine that
 * apps/desktop/index.js builds -- which is the whole reason index.js says
 * "one engine for the whole process".
 *
 * The exported module name is DaakWindowHost, deliberately host-scoped and
 * singular rather than a bare platform name: a module name that reads as
 * belonging to some other OS is how two hosts end up fighting over one
 * NativeModules key.
 */
@interface RNWindowHost : NSObject <RCTBridgeModule>

+ (instancetype)shared;

/**
 * Called by the app delegate after RCTAppDelegate has created its
 * rootViewFactory and its window. Everything before this call is inert,
 * because a root view built with a factory of nil cannot be built at all.
 *
 * The window is the dashboard's, not this class's. RCTAppDelegate already
 * built one hosting a DaakDashboard root at launch; openDashboard only has to
 * order it in. Building a SECOND window with a SECOND dashboard root would put
 * two DaakUiApp instances on one runtime, and every engine event would then
 * render the whole dashboard twice.
 */
- (void)adoptRootViewFactory:(RCTRootViewFactory *)factory;
- (void)adoptDashboardWindow:(NSWindow *)window;

- (void)presentPopoverFrom:(nullable NSStatusItem *)statusItem;
- (void)openDashboard;
- (void)closePopover;

/**
 * Ends the PROCESS, for the tray menu's Quit Daak item.
 *
 * One native quit verb, and the tray route is its only caller. The macOS app
 * menu already owns a working Quit (Main.storyboard binds it to terminate: on
 * the First Responder), so there is deliberately no second menu item here: a
 * second one would put two Quit entries in the menu bar.
 *
 * It is NOT the engine's stop verb. DaemonClientEngine.stop() sends
 * IpcRequest::Shutdown, which shuts daakd down; daakd is a launchd service, so
 * it comes straight back and the app is left in the menu bar with a dead
 * daemon. Quitting the app and stopping the daemon are two different actions.
 */
- (void)quitApp;

@end

NS_ASSUME_NONNULL_END
