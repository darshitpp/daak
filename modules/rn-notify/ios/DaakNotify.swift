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
final class DaakNotify: RCTEventEmitter, UNUserNotificationCenterDelegate {
  private static let event = "DaakNotifyEvent"
  private static let receivedCategory = "daak.received"

  // Fixed by packages/platform/src/notify.ts (DAK_RECEIVED_ACTIONS), so the ids
  // are named here. registerCategories still takes the JSON arg so a second
  // category does not need a native release.
  private static let actionTitles: [(id: String, title: String)] = [
    ("daak.open", "Open"),
    ("daak.share", "Share"),
    ("daak.folder", "Show in folder"),
  ]

  private var hasListeners = false

  private static let stashLock = NSLock()
  private static var stashed: String?

  override func supportedEvents() -> [String]! { [DaakNotify.event] }

  @objc static func requiresMainQueueSetup() -> Bool { false }

  override func startObserving() { hasListeners = true }

  override func stopObserving() { hasListeners = false }

  /// Reports the REAL answer rather than re-prompting (R34): a user who already
  /// answered -- including a denial -- must get that answer back, so JS can
  //  decide not to depend on the banner.
  @objc func requestPermission(_ resolve: @escaping RCTPromiseResolveBlock,
                               reject: RCTPromiseRejectBlock) {
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
                                resolve: RCTPromiseResolveBlock,
                                reject: RCTPromiseRejectBlock) {
    let actions = DaakNotify.actionTitles.map {
      UNNotificationAction(identifier: $0.id, title: $0.title, options: [.foreground])
    }
    let category = UNNotificationCategory(
      identifier: DaakNotify.receivedCategory, actions: actions,
      intentIdentifiers: [], options: [])
    let center = UNUserNotificationCenter.current()
    center.setNotificationCategories([category])
    // Set unconditionally, denied or not: a user who grants later must not need
    // a reinstall to get working action buttons. Setting it here is the only way
    // the didReceive handler below is ever called at all.
    center.delegate = self
    resolve(nil)
  }

  @objc func post(_ id: String, title: String, body: String, category: String,
                  payloadJson: String,
                  resolve: @escaping RCTPromiseResolveBlock,
                  reject: RCTPromiseRejectBlock) {
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

  @objc func cancel(_ id: String,
                    resolve: RCTPromiseResolveBlock,
                    reject: RCTPromiseRejectBlock) {
    let center = UNUserNotificationCenter.current()
    center.removeDeliveredNotifications(withIdentifiers: [id])
    center.removePendingNotificationRequests(withIdentifiers: [id])
    resolve(nil)
  }

  @objc func consumePendingAction(_ resolve: @escaping RCTPromiseResolveBlock,
                                  reject: RCTPromiseRejectBlock) {
    DaakNotify.stashLock.lock()
    let json = DaakNotify.stashed ?? ""
    DaakNotify.stashed = nil
    DaakNotify.stashLock.unlock()
    resolve(json)
  }

  // R33: NO transport, no crypto, no outbox. daak.share opens the OS share
  // sheet in JS (the app's presentShare); the engine outbox owns every actual
  // send. This only reports WHICH action was tapped.
  func userNotificationCenter(_ center: UNUserNotificationCenter,
                              didReceive response: UNNotificationResponse,
                              withCompletionHandler completionHandler: @escaping () -> Void) {
    let payload = response.notification.request.content.userInfo["payload"] as? String ?? "{}"
    let action = response.actionIdentifier
    if hasListeners {
      sendEvent(withName: DaakNotify.event, body: ["action": action, "payload": payload])
    } else {
      DaakNotify.stashLock.lock()
      // JSONSerialization, not a hand-rolled escaper: the payload is arbitrary
      // JSON-in-a-string, so escaping it correctly is exactly the fiddly part.
      DaakNotify.stashed = Self.json(action: action, payload: payload)
      DaakNotify.stashLock.unlock()
    }
    completionHandler()
  }

  /// willPresent is deliberately absent: without it a notification that arrives
  /// while the app is open is not shown, and this app's inbox already renders
  /// the transfer. Add a willPresent returning [[.banner]] if the design ever
  /// wants the banner while foregrounded.

  private static func json(action: String, payload: String) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: ["action": action, "payload": payload]),
          let out = String(data: data, encoding: .utf8) else { return "" }
    return out
  }
}
