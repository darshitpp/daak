#import "RNNotify.h"

#import <UserNotifications/UserNotifications.h>

static NSString *const DaakEvent = @"DaakSystemNotifyAction";
static NSString *const DaakCategory = @"daak.inbox";

// What the centre delegate needs from whoever is listening. A protocol rather
// than a bare id, so the call is type-checked instead of an untyped
// performSelector: on an id the compiler cannot see the selector at all.
@protocol DaakNotifySink <NSObject>
- (void)deliverPendingAction:(NSDictionary *)body;
@end

// THE CENTRE DELEGATE, as its own object, installed from +load.
//
// The plan makes RNNotify itself the delegate and installs it in -init. Three
// defects, only the first of them obvious:
//
//  1. UNUserNotificationCenter.delegate is a WEAK reference and the RN bridge
//     owns (and can tear down) the module instance, so the delegate silently
//     stops receiving taps. Same class of defect R32 records on mobile.
//  2. -init of a TurboModule runs when JS LOADS THE MODULE. A tap that launches
//     the app is delivered before the bridge exists, so an -init delegate was
//     nil in exactly the case a notification action exists to serve.
//  3. RCTEventEmitter DROPS an event with no listeners. Measured in this repo's
//     own React/Modules/RCTEventEmitter.m: `BOOL shouldEmitEvent =
//     (_observationDisabled || _listenerCount > 0)`. So a tap arriving before JS
//     subscribes is lost unless something holds it, which is what _pending is.
//
// +load runs at dyld load, before main(), which is earlier than the
// didFinishLaunching the mobile app uses (apps/mobile/ios/Daak/
// DaakNotificationDelegate.swift) and needs no app-target edit.
//
// Named DaakSystemNotifyDelegate, not DaakNotificationDelegate: the mobile app
// target already has a class by the latter name and the two must not be confused.
@interface DaakSystemNotifyDelegate : NSObject <UNUserNotificationCenterDelegate>
@property(nonatomic, weak) id<DaakNotifySink> sink;
+ (instancetype)current;
- (void)deliver;
- (void)stash:(NSDictionary *)body;
@end

@implementation DaakSystemNotifyDelegate {
  NSDictionary *_pending;
}

static DaakSystemNotifyDelegate *_current = nil;

+ (void)load {
  // Deliberately minimal: build the singleton and register the category. No
  // permission request here, because the prompt needs a live NSApplication and
  // +load runs before main(). -init asks instead.
  _current = [DaakSystemNotifyDelegate new];
  UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
  center.delegate = _current;

  // The ONE button that is INSTALLED. The frozen vocabulary is open | share |
  // show, named in modules/rn-notify/js/actions.ts, and this table mirrors that
  // file's inboxActions() exactly -- an action registered here but absent there
  // is a button the user can press with nothing behind it.
  //
  // 'share' and 'show' are WITHHELD under R37, the same rule mobile applies to
  // 'daak.folder' (packages/platform/src/notify.ts:10-18, and
  // ios/DaakNotify.swift:26-33): neither has an implementation on desktop --
  // there is no re-share surface, and reveal does not exist -- so a button that
  // only foregrounds the app is worse than no button. Read js/actions.ts for the
  // four places to edit together when either is implemented for real.
  //
  // UNNotificationActionOptionForeground, which the plan omits: a NON-foreground
  // action is only delivered to an ALREADY-RUNNING app, so on a cold launch the
  // button would silently do nothing. 'open' is user intent to act on a payload
  // and cannot be served headlessly either way.
  UNNotificationActionOptions daakForeground = UNNotificationActionOptionForeground;
  UNNotificationAction *open =
      [UNNotificationAction actionWithIdentifier:@"open"
                                           title:@"Open"
                                         options:daakForeground];
  UNNotificationCategory *category =
      [UNNotificationCategory categoryWithIdentifier:DaakCategory
                                              actions:@[ open ]
                                    intentIdentifiers:@[]
                                              options:0];
  [center setNotificationCategories:[NSSet setWithObject:category]];
}

+ (instancetype)current { return _current; }

- (void)stash:(NSDictionary *)body {
  @synchronized(self) {
    _pending = body;
  }
}

- (void)deliver {
  NSDictionary *body;
  @synchronized(self) {
    body = _pending;
    _pending = nil;
  }
  if (body != nil) {
    [self.sink deliverPendingAction:body];
  }
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       didReceiveNotificationResponse:(UNNotificationResponse *)response
                withCompletionHandler:(void (^)(void))completionHandler {
  // A tap on the notification BODY arrives as UNNotificationDefaultActionIdentifier.
  // Passing that through would be a lie: js/system-notify.ts types actionId as
  // 'open' | 'share' | 'show' and notify.ts's planNotifyAction returns null for
  // anything else, so the event would carry an id no caller can handle. Clicking
  // the banner means "show me this", which is `open`.
  NSString *raw = response.actionIdentifier;
  NSString *actionId =
      [raw isEqualToString:UNNotificationDefaultActionIdentifier] ? @"open" : raw;
  // payloadId comes from userInfo, NOT from the request identifier: the
  // identifier only deduplicates repeats of one payload, and coupling the two
  // would make a future change to either silently break every action.
  NSString *payloadId = response.notification.request.content.userInfo[@"payloadId"];
  completionHandler();
  if (![payloadId isKindOfClass:[NSString class]] || payloadId.length == 0) return;
  NSDictionary *body = @{ @"actionId" : actionId, @"payloadId" : payloadId };
  id<DaakNotifySink> sink = self.sink;
  if (sink != nil) {
    [sink deliverPendingAction:body];
  } else {
    // Nobody can take it yet: the tap launched the app and JS has not booted.
    // Last write wins, deliberately -- one pending action, and a second tap
    // before JS boots replaces the first rather than queueing without bound.
    [self stash:body];
  }
}

@end

// Declared here, AFTER the protocol and BEFORE the @implementation, because an
// @interface for a class has to precede its @implementation and this category
// names DaakNotifySink. One line, and it is load-bearing: without
// `<DaakNotifySink>` on the declaration, `delegate.sink = self` is an assignment
// from an unrelated type. Both errors were caught by COMPILING this file, which
// no Phase 6 JS gate does -- the same lesson as Task 5's RNTray statusItem error.
// The empty category is the whole implementation; deliverPendingAction: is
// implemented below.
@interface RNNotify () <DaakNotifySink>
@property(nonatomic) BOOL listening;
@end

@implementation RNNotify

RCT_EXPORT_MODULE(DaakSystemNotify)

// The module does NOT drive AppKit, so unlike RNShare.mm / RNDirectShare.mm /
// RNTray.mm it deliberately has NO -methodQueue and no RCTAssertMainQueue.
// UNUserNotificationCenter is thread-safe and pins nothing; serialising the
// authorisation round trip and JSON parsing behind AppKit would cost and buy
// nothing. Recorded because the absence reads as an omission.
+ (BOOL)requiresMainQueueSetup { return NO; }

- (NSArray<NSString *> *)supportedEvents { return @[ DaakEvent ]; }

// The plan asks for authorisation in -init, and -init IS the right place: it is
// the first moment a live NSApplication exists, whereas +load (which registered
// the category) runs before main(). Moving it to +load would be the bug.
//
// Alert + Sound only, no Badge: the banner is a receipt, and a dock badge on a
// file transfer is noise the user did not ask for. Same pair mobile requests
// (modules/rn-notify/ios/DaakNotify.swift:79).
//
// WHAT IS PROVEN: nothing at runtime. An earlier version of this comment said
// "PROVEN: a WARM-app action tap reaches JS end to end", and an earlier one
// before that claimed cold launch was BROKEN and pointed the next maintainer at
// an app-target UNUserNotificationCenterDelegate owner in AppDelegate.mm. Both
// were wrong, in opposite directions, and both are gone. No notification has
// been delivered on a real device this phase -- there is no macOS simulator
// runtime installed, no signed run, and no second machine -- so this file's
// runtime behaviour has been COMPILES and REVIEWED, never EXERCISED. Treat both
// paths below as UNTESTED. Do not write "works" about either, and do not write
// "broken" about either.
//
// WARM APP ALREADY RUNNING, JS ALREADY SUBSCRIBED. Wired, unexercised:
// centre delegate -> deliverPendingAction -> sendEventWithName -> onNotifyAction.
// The ordering is right by inspection: startObserving has already set the sink
// and self.listening is YES by the time any tap can arrive. Untested because
// nobody has tapped a banner on a running desktop build.
//
// COLD LAUNCH, the tap that starts the app. Wired, unexercised, and the part
// worth reading before changing: +load installs the centre delegate at dyld
// load, before main(), which is EARLIER than this -init and earlier than any
// TurboModule exists. The delegate is therefore already the centre's delegate
// when the system hands over a cold-launch response, so no app-target owner is
// needed -- that argument is structural, and is why +load is used here rather
// than -init (the defect it replaces is written at the top of this file). The
// chain is +load delegate -> stash into the pending slot -> startObserving ->
// deliver -> sendEventWithName, and each link exists. It has never been run.
// If a cold tap does not open the dashboard, the suspects are the pending slot
// and the startObserving drain -- both in this file -- and NOT a missing
// AppDelegate owner, which the ordering above rules out.
//
// WHY -init IS STILL THE RIGHT PLACE FOR THE PERMISSION REQUEST even though it
// runs late: it is the first moment a live NSApplication exists, whereas +load
// runs before main(). Moving it to +load would be the bug.

- (instancetype)init {
  if (self = [super init]) {
    [[UNUserNotificationCenter currentNotificationCenter]
        requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound)
                      completionHandler:^(BOOL granted, NSError *error) {
      // Deliberately ignored. notify: re-reads the authorisation status before
      // every post (see the R36 note there) and resolves rather than rejecting,
      // so a user who said no costs a banner, never an unhandled rejection in
      // the inbox handler that delivered the file.
      (void)granted;
      (void)error;
    }];
  }
  return self;
}

- (void)startObserving {
  self.listening = YES;
  // A tap that landed between app launch and this subscription is already in the
  // pending slot. Delivering it HERE is what makes the cold path work at all,
  // and it is why the delegate has a slot to keep. Same shape as
  // DaakNotify.swift's startObserving on mobile.
  DaakSystemNotifyDelegate *delegate = [DaakSystemNotifyDelegate current];
  delegate.sink = self;
  [delegate deliver];
}

- (void)stopObserving { self.listening = NO; }

- (void)invalidate {
  // Drop the sink so a torn-down bridge is not retained by a process-lifetime
  // object. The pending slot SURVIVES: a bridge reload is not the process
  // ending, and the tap is still owed to JS.
  [DaakSystemNotifyDelegate current].sink = nil;
  [super invalidate];
}

- (void)deliverPendingAction:(NSDictionary *)body {
  if (body == nil) return;
  // The drop is RCTEventEmitter's, not ours: sendEventWithName: warns and
  // returns when there are no listeners. Checking here keeps that warning for
  // the real mistake and turns the ordinary cold-start case into a stash.
  if (self.listening) {
    [self sendEventWithName:DaakEvent body:body];
  } else {
    [[DaakSystemNotifyDelegate current] stash:body];
  }
}

// The version and build of the installed app, as JSON. The plist keys hold
// $(MARKETING_VERSION) and $(CURRENT_PROJECT_VERSION), so a version bump in the
// project needs no edit here.
RCT_EXPORT_METHOD(appInfo : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  NSDictionary *info = [[NSBundle mainBundle] infoDictionary];
  id version = info[@"CFBundleShortVersionString"];
  id build = info[@"CFBundleVersion"];
  NSDictionary *body = @{
    @"version" : [version isKindOfClass:[NSString class]] ? version : @"",
    @"build" : [build isKindOfClass:[NSString class]] ? build : @"",
  };
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:body options:0 error:&error];
  if (data == nil) {
    reject(@"E_APPINFO", error.localizedDescription ?: @"the bundle info is not valid JSON", error);
    return;
  }
  resolve([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]);
}

RCT_EXPORT_METHOD(notify : (NSString *)payloadJson resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  NSData *data = [payloadJson dataUsingEncoding:NSUTF8StringEncoding];
  NSError *error = nil;
  id json = data == nil ? nil : [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
  // isKindOfClass, not a bare cast, for the reason RNShare.mm records: this is
  // caller-authored JSON. The plan's unchecked `payload[@"title"]` on a nil
  // payload posted a BLANK notification and still resolved.
  if (![json isKindOfClass:[NSDictionary class]]) {
    reject(@"E_BAD_PAYLOAD", error.localizedDescription ?: @"payload must be a JSON object", error);
    return;
  }
  NSDictionary *payload = (NSDictionary *)json;
  id payloadId = payload[@"payloadId"];
  id title = payload[@"title"];
  id bodyText = payload[@"body"];
  // payloadId is load-bearing twice: it is the request identifier (nil throws
  // in requestWithIdentifier:) and it is what the action event carries back.
  if (![payloadId isKindOfClass:[NSString class]] || [(NSString *)payloadId length] == 0 ||
      ![title isKindOfClass:[NSString class]] || ![bodyText isKindOfClass:[NSString class]]) {
    reject(@"E_BAD_PAYLOAD", @"payloadId, title and body must be non-empty strings", nil);
    return;
  }
  id category = payload[@"category"];

  UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
  // R36, copied from modules/rn-notify/ios/DaakNotify.swift: posting without
  // authorisation THROWS, and this is called straight from an inbox event, so a
  // rejected promise there is an unhandled rejection in the handler the user is
  // receiving a file into. A denied permission costs a BANNER, never a transfer.
  // getNotificationSettingsWithCompletionHandler:, the macOS spelling. The
  // short `getNotificationSettings:` form Apple uses on iOS is a DIFFERENT
  // selector and is not declared here -- measured: with the iOS spelling this
  // file does not compile ("no visible @interface for 'UNUserNotificationCenter'
  // declares the selector 'getNotificationSettings:'").
  [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
    UNAuthorizationStatus status = settings.authorizationStatus;
    if (status != UNAuthorizationStatusAuthorized && status != UNAuthorizationStatusProvisional) {
      resolve(nil);
      return;
    }
    UNMutableNotificationContent *content = [UNMutableNotificationContent new];
    content.title = (NSString *)title;
    content.body = (NSString *)bodyText;
    // An absent or unknown category means NO buttons, which is a notification.
    // Forcing a default here would attach three buttons to a category whose
    // actions may never have been installed.
    if ([category isKindOfClass:[NSString class]]) {
      content.categoryIdentifier = (NSString *)category;
    }
    content.userInfo = @{ @"payloadId" : (NSString *)payloadId };
    // Identifier == payloadId ON PURPOSE: the centre REPLACES a pending or
    // delivered request carrying an identifier it already has, so a repeat for
    // one payload supersedes itself instead of stacking.
    UNNotificationRequest *request =
        [UNNotificationRequest requestWithIdentifier:(NSString *)payloadId
                                             content:content
                                             trigger:nil];
    [center addNotificationRequest:request withCompletionHandler:^(NSError *addError) {
      if (addError != nil) {
        reject(@"E_NOTIFY", addError.localizedDescription, addError);
      } else {
        resolve(nil);
      }
    }];
  }];
}

@end
