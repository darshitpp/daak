#import "RNShare.h"

#import <Cocoa/Cocoa.h>
#import <React/RCTUtils.h>

@implementation RNShare {
  NSSharingServicePicker *_picker;
  NSOpenPanel *_panel;
}

RCT_EXPORT_MODULE(DaakSystemShare)

// Same one-liner as RNTray.mm/RNWindowHost.mm: this drives AppKit from an
// RCT_EXPORT_METHOD, so without it the bridge synthesises a background queue
// and every RCTAssertMainQueue below is a Debug abort.
+ (BOOL)requiresMainQueueSetup { return YES; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }

RCT_EXPORT_METHOD(share : (NSString *)payloadJson resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  RCTAssertMainQueue();
  NSData *data = [payloadJson dataUsingEncoding:NSUTF8StringEncoding];
  NSDictionary *payload = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];

  NSMutableArray *items = [NSMutableArray array];
  id text = payload[@"text"];
  if ([text isKindOfClass:[NSString class]] && [text length] > 0) {
    [items addObject:text];
  }
  // isKindOfClass, not a bare cast: a non-string here is JSON the caller hand
  // wrote, and the plan's cast was silent. normalizeShareItems already
  // guarantees NSString, so this is a one-line trust-boundary guard, not
  // validation.
  id paths = payload[@"paths"];
  if ([paths isKindOfClass:[NSArray class]]) {
    for (id path in paths) {
      if ([path isKindOfClass:[NSString class]]) {
        [items addObject:[NSURL fileURLWithPath:path]];
      }
    }
  }
  if (items.count == 0) {
    reject(@"E_EMPTY", @"nothing to share", nil);
    return;
  }

  // R5-B. Task 4 made this LSUIElement with the dashboard window orderOut: at
  // launch, so NSApp.keyWindow is nil whenever only the popover is up -- and a
  // hidden window is not a legal anchor either. RNTray owns the one piece of
  // chrome that is always on screen (the status item button), so that is the
  // anchor; the DaakTray pod is not a declared dependency here, so the class is
  // looked up by name and a nil status item (install() has not run) falls
  // through to the app's own windows.
  NSView *anchorView = nil;
  // The lookup is by NAME on purpose: DaakShare declares no dependency on the
  // DaakTray pod, so RNTray.h is not importable here. But NSClassFromString
  // returns a Class, and sending a CLASS METHOD through it is a compile error
  // ("no known class method for selector 'statusItem'") -- the compiler has no
  // interface to check against. So the class method is invoked through
  // -performSelector:, which is untyped, and the result is cast to the one type
  // actually needed. respondsToSelector: keeps a missing tray a graceful
  // fallback rather than an unrecognised-selector throw.
  Class trayClass = NSClassFromString(@"RNTray");
  SEL statusItemSelector = NSSelectorFromString(@"statusItem");
  if (trayClass != nil && [trayClass respondsToSelector:statusItemSelector]) {
    NSStatusItem *statusItem = (NSStatusItem *)[trayClass performSelector:statusItemSelector];
    anchorView = statusItem.button;
  }
  NSWindow *window = anchorView.window ?: NSApp.keyWindow ?: NSApp.mainWindow;
  if (window == nil || (!window.isVisible && anchorView == nil)) {
    reject(@"E_NO_WINDOW", @"no visible window to anchor the share sheet", nil);
    return;
  }

  NSRect rect = anchorView != nil ? anchorView.bounds : window.contentView.bounds;
  NSView *view = anchorView != nil ? anchorView : window.contentView;

  // R5-C. The header states no ownership contract, but the picker is presented
  // by showRelativeToRect: (the document says: call it on mouseDown) and a
  // deallocated picker takes its share menu down with it, so it is held here
  // and replaced by the next share.
  NSSharingServicePicker *picker = [[NSSharingServicePicker alloc] initWithItems:items];
  _picker = picker;
  [picker showRelativeToRect:rect ofView:view preferredEdge:NSRectEdgeMinY];
  resolve(nil);
}

// The document picker. Same signature as the mobile DaakShare.pickDocuments, so
// the composer's injected picker is one `() => Promise<string[]>` on every
// platform and packages/ui cannot tell them apart.
//
// Settles in the panel's COMPLETION, never around a blocking run: NSOpenPanel
// presents a SHEET, which has no return value at all, so the completion handler
// is the only place the selection can be read. runModal is the fallback for no
// window (this app is LSUIElement with the dashboard ordered out), and it runs
// its own nested event loop -- so its result is read AFTER it returns, inside
// this method, which is the one place a modal response is legal.
RCT_EXPORT_METHOD(pickDocuments : (BOOL)multiple resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  RCTAssertMainQueue();

  NSOpenPanel *panel = [NSOpenPanel openPanel];
  panel.allowsMultipleSelection = multiple;
  // A REPLACING panel: the previous one is held so it is not deallocated under
  // the sheet, and replaced by the next pick, exactly like _picker above.
  _panel = panel;

  // The tray anchor, reused verbatim from share() above for the reason that
  // comment gives: NSApp.keyWindow is nil whenever only the status item is up.
  // The lookup is by NAME (no declared DaakTray dependency here) and the class
  // method goes through -performSelector: because sending it through a Class is
  // a compile error -- see the full note in share().
  NSView *anchorView = nil;
  Class trayClass = NSClassFromString(@"RNTray");
  SEL statusItemSelector = NSSelectorFromString(@"statusItem");
  if (trayClass != nil && [trayClass respondsToSelector:statusItemSelector]) {
    NSStatusItem *statusItem = (NSStatusItem *)[trayClass performSelector:statusItemSelector];
    anchorView = statusItem.button;
  }
  NSWindow *window = anchorView.window ?: NSApp.keyWindow ?: NSApp.mainWindow;

  // One reader for both shapes, so the sheet and the modal arm cannot disagree
  // about paths, order, or what a Cancel means.
  void (^resolvePaths)(void) = ^{
    if (panel.URLs == nil || panel.URLs.count == 0) {
      // Cancelled. An EMPTY LIST, never a reject: dismissing a picker is an
      // ordinary user action and a reject here is a red box in the app.
      resolve(@[]);
      return;
    }
    // filePath, not absoluteString/-path: engine.send takes filesystem paths and
    // the composer's remove-<path> label reads them back.
    NSMutableArray<NSString *> *paths = [NSMutableArray arrayWithCapacity:panel.URLs.count];
    for (NSURL *url in panel.URLs) {
      [paths addObject:url.filePath];
    }
    resolve(paths);
  };

  // The sheet needs a window that is actually ON SCREEN. anchorView alone does not
  // say that: the tray button exists from install() onward, so once it is present
  // it satisfies an `anchorView != nil` test even when `window` came from
  // NSApp.mainWindow and that window is ordered out -- this app's normal state
  // (LSUIElement, AppDelegate orderOut at launch). beginSheetModalForWindow: on
  // an offscreen window throws NSInvalidArgumentException, so the first "Add
  // files" click of a menu-bar-only run would crash.
  //
  // share() gates the same way and REJECTS the no-window case. Here the picker
  // must still work with no window, so this falls through to runModal instead of
  // rejecting -- that is the only difference from share().
  if (window != nil && window.isVisible) {
    // The SHEET. completionHandler: is not optional in practice: with a nil
    // handler there is nowhere to answer, and the promise would never settle.
    [panel beginSheetModalForWindow:window completionHandler:^(NSModalResponse response) {
      resolvePaths();
    }];
  } else {
    // No window to anchor to. runModal blocks this nested loop and RETURNS the
    // response, so the result is read here and not in a handler.
    [panel runModal];
    resolvePaths();
  }
}

@end
