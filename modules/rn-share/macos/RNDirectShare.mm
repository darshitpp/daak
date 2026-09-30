#import "RNDirectShare.h"

#import <Cocoa/Cocoa.h>
#import <React/RCTUtils.h>

// A class extension, not an ivar block entry: a class extension has to precede
// the @implementation (RNTray.mm carries the same note and the same typo).
//
// The plan declares NO interface for -directShare: and types representedObject
// as `id`. Declaring the selector here is what makes @selector(directShare:)
// a checked call instead of a string, and the sender parameter is typed so the
// action really is an NSMenuItem *.
@interface RNDirectShare ()
- (void)directShare:(NSMenuItem *)sender;
@end

@implementation RNDirectShare

RCT_EXPORT_MODULE(DaakDirectShare)

// DESKTOP-ONLY. The mobile-reachable barrel (modules/rn-share/js/index.ts)
// must never re-export this. There is no JS spec on purpose: the only caller is
// native menu code, and a legacy RCTBridgeModule is not a TurboModule.
//
// Same one-liner as RNShare.mm/RNTray.mm: this drives AppKit from an
// RCT_EXPORT_METHOD, so without it the bridge synthesises a background queue
// and the RCTAssertMainQueue below is a Debug abort.
+ (BOOL)requiresMainQueueSetup { return YES; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }

- (void)directShare:(NSMenuItem *)sender {
  NSString *deviceId = sender.representedObject;
  // No percent-encoding: a device id is 32 lowercase hex chars by the time it
  // leaves the engine (crates/daakd/src/lib.rs:193 hex::encode), so there is
  // nothing in it for a URL to reinterpret.
  //
  // `deviceId`, NOT the plan's `device`: the shipped mobile parser reads
  // `deviceId` (apps/mobile/src/deeplink.ts:47). Emitting `device` here would
  // mint a link this very task's parser and mobile both reject. The parameter
  // name is a contract with apps/mobile/src/deeplink.ts and is pinned by
  // apps/desktop/test/direct-share-contract.spec.ts.
  NSString *urlString = [NSString stringWithFormat:@"daak://send?deviceId=%@", deviceId];
  NSURL *url = [NSURL URLWithString:urlString];
  if (url == nil) return;
  [[NSWorkspace sharedWorkspace] openURL:url];
}

// devicesJson is a JSON array of {deviceId, name} from engine.devices()
// (crates/daakd/src/lib.rs:462). Every field is read as `id` and checked with
// isKindOfClass, exactly like RNShare.mm does for its payload: this is a trust
// boundary and a bare cast is how a menu ends up titled "(null)".
//
// Failure is EXPLICIT. The plan resolves(nil) whatever the JSON was, so a
// malformed list left the previous menu in place with no signal to the caller:
// the menu silently described a peer set that no longer exists. Four outcomes,
// all intentional:
//   - not JSON, or not an array -> reject. The caller asked to publish a device
//     list and could not.
//   - a non-empty array with no usable entry -> reject, for the same reason.
//   - some entries unusable -> those entries are skipped and the rest publish.
//     One peer with a missing name is not a reason to blank the whole menu.
//   - empty array -> publish the disabled "No paired devices" row, which is a
//     real state (nothing paired yet), not an error.
RCT_EXPORT_METHOD(setDevices : (NSString *)devicesJson resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  RCTAssertMainQueue();
  NSData *data = [devicesJson dataUsingEncoding:NSUTF8StringEncoding];
  NSError *error = nil;
  id json = data == nil ? nil : [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
  if (![json isKindOfClass:[NSArray class]]) {
    reject(@"E_BAD_DEVICES", error.localizedDescription ?: @"devices must be a JSON array", error);
    return;
  }
  // Typed local, not `id json`: dot syntax on an `id` compiles only for a
  // property the compiler can see, and .count on `id` does not. (This is the
  // exact error the build reported -- RNDirectShare.mm:83 'property count not
  // found on object of type __strong id'.)
  NSArray *devices = (NSArray *)json;

  NSMenu *shareMenu = [[NSMenu alloc] initWithTitle:@"Share"];
  NSUInteger published = 0;
  for (id device in devices) {
    if (![device isKindOfClass:[NSDictionary class]]) continue;
    NSDictionary *entry = (NSDictionary *)device;
    id name = entry[@"name"];
    id deviceId = entry[@"deviceId"];
    if (![name isKindOfClass:[NSString class]] || [(NSString *)name length] == 0) continue;
    if (![deviceId isKindOfClass:[NSString class]] || [(NSString *)deviceId length] == 0) continue;
    NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:(NSString *)name action:@selector(directShare:) keyEquivalent:@""];
    item.target = self;
    item.representedObject = (NSString *)deviceId;
    [shareMenu addItem:item];
    published++;
  }
  if (devices.count > 0 && published == 0) {
    reject(@"E_BAD_DEVICES", @"no device in the list had both a name and a deviceId", nil);
    return;
  }
  if (published == 0) {
    NSMenuItem *empty = [[NSMenuItem alloc] initWithTitle:@"No paired devices" action:nil keyEquivalent:@""];
    empty.enabled = NO;
    [shareMenu addItem:empty];
  }

  NSMenu *mainMenu = NSApp.mainMenu;
  // Both guards are load-bearing. The plan inserts at
  // mainMenu.numberOfItems - 1 unconditionally, which on a nil menu is a
  // message to nil (no menu, and resolve(nil) still fires) and on an EMPTY menu
  // is an insert at index -1, an NSRangeException. Both are reachable:
  // setDevices can run before applicationDidFinishLaunching has built the main
  // menu, and the storyboard is what supplies that menu in the first place.
  if (mainMenu == nil || mainMenu.numberOfItems == 0) {
    reject(@"E_NO_MAIN_MENU", @"no application main menu to install the Share menu into", nil);
    return;
  }
  NSMenuItem *existing = [mainMenu itemWithTitle:@"Share"];
  if (existing != nil) {
    [mainMenu removeItem:existing];
  }
  NSMenuItem *shareRoot = [[NSMenuItem alloc] initWithTitle:@"Share" action:nil keyEquivalent:@""];
  shareRoot.submenu = shareMenu;
  // numberOfItems - 1 puts Share immediately before the LAST item, which in the
  // generated Main.storyboard is Help. The index is recomputed AFTER the
  // removal above, so repeated calls cannot walk the menu leftwards.
  [mainMenu insertItem:shareRoot atIndex:mainMenu.numberOfItems - 1];
  resolve(nil);
}

@end
