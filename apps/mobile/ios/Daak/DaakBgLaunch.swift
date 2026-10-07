import BackgroundTasks
import Foundation

/// The ONE engine-wake slot that the native background triggers reach.
///
/// The engine is held by the `Daak` TurboModule, and that module does not exist
/// until the React bridge boots. A BGTask can arrive before the bridge, so this
/// slot is nil on a cold launch and the wake is a no-op then. The wake is a
/// single shared call, `Engine::background_wake`, and this slot does not add a
/// second one.
enum DaakBridge {
  /// Set by `Daak.start()` when the engine is up, cleared by `Daak.shutdown()`.
  static var backgroundWake: (() -> Void)?
}

/// The ONE owner of the two BGTaskScheduler registrations.
///
/// This lives in the APP TARGET, not the pod, for the same reason
/// DaakNotificationDelegate does (R32/Critical 3): iOS launches the process to
/// deliver a BGTask, and the rn-bgsched TurboModule does not exist until the
/// React bridge has booted. A registration made from JS therefore misses
/// exactly the cold launch it exists for, and the app's engine is not running
/// at that moment either.
///
/// WHAT THE HANDLER DOES, and what it deliberately does NOT do:
///  - it completes the task and resubmits the next refresh, which is the whole
///    contract BGTaskScheduler offers;
///  - it does NOT drain anything. There is no drain entry point on the engine
///    (GAP 1: the shared engine holder the plan names does not exist in this
///    repo, and never has). The Rust
///    outbox worker spawned by Engine::start runs a 5s ticker and is poked by
///    notify_peer_online on every enqueue and on peer presence, so a queued row
///    is delivered on reconnect without anyone asking. Adding a drain() here
///    would race that ticker for the same rows.
///  - it does NOT call an engine wake method (GAP 2). That method does not exist
///    until Phase 7 Task 3 (R4), and adding it is a UDL/wire change that this
///    phase did not spec. The engine the OS just launched owns its own worker,
///    so there is nothing for a wake to do here.
///
/// ponytail: the handler is intentionally a no-op beyond the reschedule. If a
/// background slot ever has to do real work, the honest shape is a bounded
/// task that leases the engine, not a drain() that races the ticker.
@objc final class DaakBgLaunch: NSObject {
  /// Duplicated verbatim in Info.plist and packages/platform/src/bgsched.ts
  /// because none of the three can import the others. A rename on one side is
  /// silent: iOS refuses to submit a request for an identifier it does not
  /// permit and never runs it. Pinned by
  /// apps/mobile/src/__tests__/backgroundExec.test.ts.
  @objc static let refreshId = "dev.darshit.daak.refresh"
  @objc static let processingId = "dev.darshit.daak.processing"

  private static let interval: TimeInterval = 15 * 60

  private override init() { super.init() }

  /// Idempotent; call from application:didFinishLaunchingWithOptions: before
  /// iOS can deliver either task. Registering the same identifier twice is an
  /// error the second time, so the guard matters if launch runs again.
  ///
  /// The FIRST SUBMIT LIVES HERE, not in handle(). iOS never delivers a task
  /// that was not submitted, and a submit made only from inside the granted
  /// handler is circular: no submit -> no grant -> no handler -> no submit, so
  /// the schedule runs at most once and usually never. install() runs from
  /// didFinishLaunchingWithOptions, the only place guaranteed to run before
  /// anything can be delivered, so it is the only correct producer.
  ///
  /// No applicationDidEnterBackground resubmit on top of this: a launch that
  /// did not consume the pending request would submit a duplicate, and iOS
  /// rejects a second pending request for the same identifier. The next launch
  /// is the honest retry, and it is what the try? below already relies on.
  @objc static func install() {
    if registeredRefresh || registeredProcessing { return }
    // register returns whether THIS identifier was accepted, so each is
    // tracked separately. Assigning both to one flag made the second result
    // the discarded one, and a refresh-only success then reported the pair as
    // half-registered while re-running install tried to register the refresh a
    // second time -- which BGTaskScheduler rejects.
    registeredRefresh = BGTaskScheduler.shared.register(
      forTaskWithIdentifier: refreshId, using: nil
    ) { task in handle(task as! BGAppRefreshTask) }
    registeredProcessing = BGTaskScheduler.shared.register(
      forTaskWithIdentifier: processingId, using: nil
    ) { task in handle(task as! BGProcessingTask) }
    // Book both chains, unconditionally. A successful registration does not
    // mean a request exists, and the handler is the only other submitter, so
    // skipping these leaves the whole feature inert behind a plist entry.
    scheduleRefresh()
    scheduleProcessing()
  }

  /// iOS delivers each launch independently, so a second one (fast app switch,
  /// a dev-menu reload) must not fail on a duplicate registration.
  private static var registeredRefresh = false
  private static var registeredProcessing = false

  private static func handle(_ task: BGTask) {
    // The granted window, measured for real: entry to completion, in ms. This
    // is the only number iOS hands us that nobody has to fake, and it is the
    // half of the spike that is honestly measurable today.
    let startedAt = Date()
    // Nothing to cancel: the body below never blocks. The handler is set
    // anyway, because a BGTask left without one is killed at its deadline with
    // no completion, which iOS counts as a failure for every future request.
    task.expirationHandler = { }
    // Wake the engine's shared outbox worker if the module has started one.
    // On a cold launch this is nil; the newly launched engine drains itself.
    DaakBridge.backgroundWake?()
    task.setTaskCompleted(success: true)
    appendSpikeLine(taskId: task.identifier, startedAt: startedAt)
    // A one-shot BGAppRefreshTask is consumed. The chain only continues if the
    // handler books the next one, so this line is what makes the schedule a
    // schedule rather than a single run.
    scheduleRefresh()
  }

  /// One JSON line per delivery, appended to the App Group container so a
  /// measurement run can read it. Append, creating the file if missing; no
  /// locking ceremony, because the OS serializes deliveries and this is a
  /// measurement, not a log Daak depends on.
  ///
  /// WHY ONLY THREE FIELDS: the analyzer also reads `dueAtStart` and `drained`,
  /// and nothing observable produces them. A BGTask is delivered into a process
  /// whose JS bridge may not exist, and the engine has no wake, drain or row
  /// count entry point on this side until Phase 7 Task 3 (GAP 1/GAP 2, R61).
  /// The plan's `wakeEngine` stub posted a Notification nobody observed and
  /// returned a hard-coded 0, which would have made a README 24 h run look
  /// like it validated background drain. The absent fields ARE the finding.
  private static func appendSpikeLine(taskId: String, startedAt: Date) {
    let line: [String: Any] = [
      "taskId": taskId,
      "startedAt": Int(startedAt.timeIntervalSince1970 * 1000),
      "grantedMs": Int(Date().timeIntervalSince(startedAt) * 1000),
    ]
    guard let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.dev.darshit.daak"),
          let data = try? JSONSerialization.data(withJSONObject: line),
          let text = String(data: data, encoding: .utf8) else { return }
    let url = dir.appendingPathComponent("bg-spike.jsonl")
    if FileManager.default.fileExists(atPath: url.path), let handle = try? FileHandle(forWritingTo: url) {
      handle.seekToEndOfFile()
      handle.write(Data((text + "\n").utf8))
      try? handle.close()
    } else {
      try? (text + "\n").write(to: url, atomically: true, encoding: .utf8)
    }
  }

  /// Best-effort by design: submit() throws when the OS is out of budget, and
  /// there is nothing to recover with. install() re-books on every app start,
  /// so a missed submit is self-healing at next launch -- and that is TRUE now
  /// rather than aspirational, because install() is the first submitter.
  @objc static func scheduleRefresh() {
    let request = BGAppRefreshTaskRequest(identifier: refreshId)
    request.earliestBeginDate = Date(timeIntervalSinceNow: interval)
    try? BGTaskScheduler.shared.submit(request)
  }

  /// The processing chain. It was registered and permitted from Task 10 and
  /// submitted by NOTHING, so the plan's scheduleProcessing(15 * 60) crossed
  /// the bridge, computed a number and dropped it.
  ///
  /// Both OS preconditions stay FALSE, per the plan.
  /// requiresNetworkConnectivity would be meaningless for Daak: the OS can
  /// only answer "is there internet", while a reachable peer is a LAN fact
  /// this app already knows better than the OS does. Pinned off by
  /// backgroundExec.test.ts.
  @objc static func scheduleProcessing() {
    let request = BGProcessingTaskRequest(identifier: processingId)
    request.earliestBeginDate = Date(timeIntervalSinceNow: interval)
    try? BGTaskScheduler.shared.submit(request)
  }
}
