import BackgroundTasks
import Foundation
import React

/// The JS-facing half of background execution.
///
/// WHY THERE IS NO configure THAT REGISTERS THE BG TASKS (the plan's shape):
/// the plan has this module register both identifiers, and AppDelegate
/// register the same two with empty closures. That is two owners, and
/// BGTaskScheduler keeps the FIRST registration and silently ignores the rest,
/// so the AppDelegate no-op becomes the real handler and every line of the body
/// below is dead code that reads as working. Ruling: the APP TARGET owns
/// registration, in apps/mobile/ios/Daak/DaakBgLaunch.swift, for the reason
/// R32 already paid for on notifications: iOS launches the process for a
/// BGTask and this TurboModule does not exist until the bridge has booted, so a
/// registration made from JS misses exactly the cold launch it exists for.
///
/// WHY THERE IS NO DRAIN HERE (GAP 1): the plan calls a shared engine holder's
/// drain from this file. No such class exists in this repo, and never has, and
/// the engine has no drain entry point at all. The outbox worker drains ITSELF:
/// OutboxWorker::spawn runs a 5s ticker and is poked by notify_peer_online on
/// every enqueue and on peer presence. A queued row is therefore delivered on
/// reconnect with nobody asking. Adding a drain entry point here would race
/// that ticker for the same rows.
///
/// WHY THERE IS NO WAKE CALL HERE (GAP 2): the plan calls an engine wake method
/// from this file. That method arrives in Phase 7 Task 3 (R4); it does not exist
/// now, and adding it would be a UDL and wire change nobody specced for this
/// phase. Ruling: dropped. The launch handler is process-local and the outbox
/// ticker is already running inside the engine the OS launched, so there is
/// nothing left for a wake to do.
@objc(DaakBgSched)
class DaakBgSched: RCTEventEmitter {
  // `override` is required: RCTEventEmitter declares this, and the omission sat
  // here uncompiled until 2026-10-01, when fixing the podspec source_files made
  // this file reach a compiler for the first time. The four NSObject modules
  // (clipboard, fspaths, qrscanner, securestore, share) declare the same method
  // WITHOUT override, correctly: NSObject does not define it. See also
  // DaakNotify.swift for the same one-word fix.
  override class func requiresMainQueueSetup() -> Bool { false }

  /// No supported events. The class is RCTEventEmitter only so its shape
  /// matches DaakNotify/Daak exactly; a Spec addListener/removeListeners pair
  /// is required by the generated protocol, and an emitter that never emits
  /// promises nothing to any listener.
  override func supportedEvents() -> [String]! { [] }

  /// No-op here for the reason in the class comment: registration is the app
  /// target's job, at launch, before any JS exists.
  @objc func configure(_ resolve: @escaping RCTPromiseResolveBlock,
                       reject: @escaping RCTPromiseRejectBlock) {
    resolve(nil)
  }

  /// NO SUBMIT HERE, on purpose. The real BGAppRefreshTaskRequest is submitted
  /// by the APP TARGET (`apps/mobile/ios/Daak/DaakBgLaunch.swift`), from
  /// `install()` at launch and again at the end of every launch handler. A JS
  /// submit is a DUPLICATE request and iOS rejects the second one, so giving
  /// this a body does not refresh more often -- it breaks the real request.
  /// See the class comment for why the app target owns this (R80).
  @objc func scheduleAppRefresh(_ resolve: @escaping RCTPromiseResolveBlock,
                               reject: @escaping RCTPromiseRejectBlock) {
    resolve(nil)
  }

  /// NO SUBMIT HERE either, same reason as scheduleAppRefresh: the
  /// BGProcessingTaskRequest is submitted by the app target, not this module,
  /// so `earliestSeconds` is accepted and ignored on iOS.
  @objc func scheduleProcessing(_ earliestSeconds: NSNumber,
                                resolve: @escaping RCTPromiseResolveBlock,
                                reject: @escaping RCTPromiseRejectBlock) {
    resolve(nil)
  }

  /// iOS has no foreground-service equivalent, and a BGTask already runs under
  /// a time budget the OS enforces. An explicit resolve is the honest answer.
  @objc func startForegroundSync(_ label: String,
                                resolve: @escaping RCTPromiseResolveBlock,
                                reject: @escaping RCTPromiseRejectBlock) {
    resolve(nil)
  }

  @objc func stopForegroundSync(_ resolve: @escaping RCTPromiseResolveBlock,
                               reject: @escaping RCTPromiseRejectBlock) {
    resolve(nil)
  }

  /// The outbox ticker already drains. See GAP 1 in the class comment.
  @objc func enqueueDrain(_ resolve: @escaping RCTPromiseResolveBlock,
                          reject: @escaping RCTPromiseRejectBlock) {
    resolve(nil)
  }

  /// iOS has no per-app battery-optimisation allowlist, so there is nothing to
  /// open. A resolve, not a rejection: the Settings button must not report a
  /// failure for a platform that has no such failure.
  @objc func requestBatteryExemption(_ resolve: @escaping RCTPromiseResolveBlock,
                                     reject: @escaping RCTPromiseRejectBlock) {
    resolve(nil)
  }
}
