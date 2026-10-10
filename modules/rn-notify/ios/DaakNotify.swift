import Foundation
import React
import UserNotifications

/// R32: the SPEC/codegen surface stays (the app is New Architecture), and the
/// event surface is RCTEventEmitter -- the same combination apps/mobile/ios/
/// Daak.swift + DaakModule.mm already use in this repo, and the same one
/// packages/platform/src/notify.ts requires via new NativeEventEmitter(module).
/// The generated DaakNotifySpec protocol supplies the TurboModule plumbing;
/// sendEvent(withName:body:) delivers on the global RCTDeviceEventEmitter the
/// JS emitter subscribes to, and addListener/removeListeners in the Spec are
/// what that emitter calls for its listener bookkeeping.
///
/// One gap RCTEventEmitter cannot cover, closed rather than left silent: it
/// DROPS an event with no listeners, and a tapped notification is exactly that
/// case (the user tapped it while the app was dead). So the action is stashed
/// and handed to JS by consumePendingAction once it is listening.
@objc(DaakNotify)
final class DaakNotify: RCTEventEmitter {
  private static let event = "DaakNotifyEvent"
  private static let receivedCategory = "daak.received"

  // Fixed by packages/platform/src/notify.ts (DAK_RECEIVED_ACTIONS), so the ids
  // are named here. registerCategories still takes the JSON arg so a second
  // category does not need a native release.
  private static let actionTitles: [(id: String, title: String)] = [
    ("daak.open", "Open"),
    ("daak.share", "Share"),
    // R37: daak.folder stays in the frozen vocabulary (DAK_RECEIVED_ACTIONS in
    // notify.ts) but is deliberately NOT installed. reveal has no implementation
    // on either platform, and a button that does nothing is worse than no
    // button. The Kotlin post() withholds it the same way.
  ]

  private var hasListeners = false

  // Darwin notification posted by the app-target launch delegate
  // (DaakNotificationDelegate) when a tapped action is stashed on disk. The
  // two targets cannot import each other -- the app target has no import path
  // into this pod and the pod must not depend on the app -- and this repo
  // already uses exactly this Darwin pair (DaakIntentBridge posts, DaakShare
  // observes). So the two constants below are duplicated between the targets
  // deliberately. Nothing else crosses the boundary; the payload rides in the
  // file, not in the wakeup.
  private static let actionChanged = "dev.darshit.daak.notify.action.changed"
  private var observer: UnsafeMutableRawPointer?

  // The App Group stash is read from TWO threads: the RN module queue
  // (consumePendingAction) and whatever thread posted the Darwin notification
  // (deliverStashed). Two independent peek-then-clear blocks both peek before
  // either clears, so one warm-app tap delivered daak.share twice and opened two
  // share sheets. One lock, one drain, both call sites routed through it.
  private static let stashLock = NSLock()

  override func supportedEvents() -> [String]! { [DaakNotify.event] }

  // `override`, and it was missing until 2026-10-01. RCTEventEmitter declares
  // requiresMainQueueSetup, so this overrides it. Nothing caught the omission
  // because the podspec's source_files resolved to a nonexistent ios/ios/**
  // and CocoaPods compiled ZERO sources for every @daak iOS pod -- this file
  // had never been through a compiler. The other RCTEventEmitter in the tree,
  // DaakBgSched.swift, gets the same rule right; see react-native.config.js.
  override class func requiresMainQueueSetup() -> Bool { false }

  override func startObserving() {
    hasListeners = true
    // A tap that landed between app launch and this subscription is on disk
    // and nobody has emitted it yet. Delivering here rather than waiting for
    // the next tap is what stops the boot-gap event from needing consumePending
    // Action's timing to be lucky.
    deliverStashed()
  }

  override func stopObserving() { hasListeners = false }

  /// Reports the REAL answer rather than re-prompting (R34): a user who already
  /// answered -- including a denial -- must get that answer back, so JS can
  //  decide not to depend on the banner.
  @objc func requestPermission(_ resolve: @escaping RCTPromiseResolveBlock,
                               reject: @escaping RCTPromiseRejectBlock) {
    let center = UNUserNotificationCenter.current()
    center.getNotificationSettings { settings in
      switch settings.authorizationStatus {
      case .notDetermined:
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
          resolve(granted)
        }
      case .denied:
        resolve(false)
      default:
        resolve(true)
      }
    }
  }

  @objc func registerCategories(_ categoriesJson: String,
                                resolve: @escaping RCTPromiseResolveBlock,
                                reject: @escaping RCTPromiseRejectBlock) {
    let actions = DaakNotify.actionTitles.map {
      UNNotificationAction(identifier: $0.id, title: $0.title, options: [.foreground])
    }
    let category = UNNotificationCategory(
      identifier: DaakNotify.receivedCategory, actions: actions,
      intentIdentifiers: [], options: [])
    let center = UNUserNotificationCenter.current()
    center.setNotificationCategories([category])
    // The centre delegate is NOT installed here. It is installed at app launch
    // by DaakNotificationDelegate.install(), because on a killed app iOS
    // delivers the tapped response at launch, before this module exists at all:
    // a delegate set from JS is nil in exactly the case the stash exists for.
    // What JS CAN do is pick up the live path, so the observer goes here.
    if observer == nil {
      let opaque = Unmanaged.passUnretained(self).toOpaque()
      CFNotificationCenterAddObserver(
        CFNotificationCenterGetDarwinNotifyCenter(),
        opaque,
        { _, observer, _, _, _ in
          guard let observer else { return }
          let emitter = Unmanaged<DaakNotify>.fromOpaque(observer).takeUnretainedValue()
          emitter.deliverStashed()
        },
        Self.actionChanged as CFString, nil, .deliverImmediately)
      // AddObserver RETURNS Void. The handle we keep for RemoveObserver is the
      // opaque pointer we just passed in, so it is stored here instead.
      observer = opaque
    }
    resolve(nil)
  }

  @objc func post(_ id: String, title: String, body: String, category: String,
                  payloadJson: String,
                  resolve: @escaping RCTPromiseResolveBlock,
                  reject: @escaping RCTPromiseRejectBlock) {
    let center = UNUserNotificationCenter.current()
    // R36: posting without authorization throws, and this is called straight
    // from the engine's inbox.received handler. Skip the banner, keep the
    // transfer: the inbox is the source of truth.
    center.getNotificationSettings { settings in
      let status = settings.authorizationStatus
      guard status == .authorized || status == .provisional || status == .ephemeral else {
        resolve(nil)
        return
      }
      let content = UNMutableNotificationContent()
      content.title = title
      content.body = body
      content.categoryIdentifier = category
      // userInfo must be property-list shaped, so the JSON travels as a String
      // and is handed back to JS unchanged.
      content.userInfo = ["payload": payloadJson]
      let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
      center.add(request) { error in
        if let error { reject("E_NOTIFY", error.localizedDescription, error) }
        else { resolve(nil) }
      }
    }
  }

  /// The version and build of the installed app, as JSON. Both values come from
  /// the app bundle. The keys hold $(MARKETING_VERSION) and
  /// $(CURRENT_PROJECT_VERSION) in the project, so a version bump needs no edit
  /// here.
  @objc func appInfo(_ resolve: @escaping RCTPromiseResolveBlock,
                     reject: @escaping RCTPromiseRejectBlock) {
    let info = Bundle.main.infoDictionary ?? [:]
    let body: [String: String] = [
      "version": info["CFBundleShortVersionString"] as? String ?? "",
      "build": info["CFBundleVersion"] as? String ?? "",
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: body),
          let json = String(data: data, encoding: .utf8)
    else {
      reject("E_APPINFO", "the bundle info is not valid JSON", nil)
      return
    }
    resolve(json)
  }

  @objc func cancel(_ id: String,
                    resolve: @escaping RCTPromiseResolveBlock,
                    reject: @escaping RCTPromiseRejectBlock) {
    let center = UNUserNotificationCenter.current()
    center.removeDeliveredNotifications(withIdentifiers: [id])
    center.removePendingNotificationRequests(withIdentifiers: [id])
    resolve(nil)
  }

  @objc func consumePendingAction(_ resolve: @escaping RCTPromiseResolveBlock,
                                  reject: @escaping RCTPromiseRejectBlock) {
    // On disk in the App Group, not in a static: the whole point is surviving the
    // process being killed between the tap and JS booting. Cleared only here,
    // after the value has been handed to JS.
    resolve(drainStashed { _ in false })
  }

  // R33: NO transport, no crypto, no outbox. daak.share opens the OS share
  // sheet in JS (the app's presentShare); the engine outbox owns every actual
  // send. This only reports WHICH action was tapped.
  private func deliverStashed() {
    // Un-listened means the drain in consumePendingAction is the only delivery
    // path. Emitting here would drop it into nothing, which is the defect the
    // on-disk stash exists to prevent.
    guard hasListeners else { return }
    var body: [String: String]?
    drainStashed { json in
      body = DaakNotify.parse(json)
      // Stays on disk when it cannot be parsed, i.e. cannot be delivered.
      return body == nil
    }
    if let body { sendEvent(withName: DaakNotify.event, body: body) }
  }

  /// THE one reader of the App Group stash. Peeks, parses, and clears inside one
  /// critical section so the two callers cannot both see the same value.
  /// - Parameter keeping: return true to LEAVE the value on disk (the caller
  ///   could not deliver it). consumePendingAction always takes; deliverStashed
  ///   keeps anything it could not emit, which is the whole point of the stash.
  /// - Returns: the stashed JSON, or "" when nothing is stashed.
  private func drainStashed(keeping: (String) -> Bool) -> String {
    DaakNotify.stashLock.lock()
    defer { DaakNotify.stashLock.unlock() }
    let json = DaakNotifyActionFile.peek()
    if !json.isEmpty && !keeping(json) { DaakNotifyActionFile.clear() }
    return json
  }

  private static func parse(_ json: String) -> [String: String]? {
    guard let data = json.data(using: .utf8),
          let body = try? JSONSerialization.jsonObject(with: data) as? [String: String]
    else { return nil }
    return body
  }

  deinit {
    if let observer {
      CFNotificationCenterRemoveObserver(
        CFNotificationCenterGetDarwinNotifyCenter(),
        observer, CFNotificationName(Self.actionChanged as CFString), nil)
    }
  }
}

/// The reader half of the cold-start stash. The WRITER is
/// apps/mobile/ios/Daak/DaakNotificationDelegate.swift, in the app target:
/// iOS delivers a tapped action to the app process at launch, long before this
/// pod's code is reachable. Two halves rather than one shared type because the
 /// two targets cannot import each other.
///
/// The App Group is what makes this survive process death at all -- the stash
/// the launch delegate wrote is read back after the bridge boots. peek() does
/// not delete: the module clears only once the value has been handed to JS, so
/// a second kill before that still finds the action on disk.
enum DaakNotifyActionFile {
  private static let appGroup = "group.dev.darshit.daak"
  private static let relativePath = "notify/pending-action.json"

  static func peek() -> String {
    let fm = FileManager.default
    guard let container = fm.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
    else { return "" }
    let final = container.appendingPathComponent(relativePath)
    guard let data = try? Data(contentsOf: final),
          let json = String(data: data, encoding: .utf8), !json.isEmpty
    else { return "" }
    return json
  }

  static func clear() {
    let fm = FileManager.default
    guard let container = fm.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
    else { return }
    try? fm.removeItem(at: container.appendingPathComponent(relativePath))
  }
}
