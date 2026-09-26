// EventSink conformance + method bodies for the Daak TurboModule; the method
// table lives in DaakModule.mm. Signatures mirror crates/daak-ffi/src/daak.udl.
import Foundation
import daakFFI

@objc(Daak)
final class Daak: RCTEventEmitter, EventSink {
  private var engine: FfiEngine?

  override func supportedEvents() -> [String]! { ["DaakEvent"] }

  @objc func start(_ dataDir: String, displayName: String, listenPort: Double,
                   resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.global().async {
      do {
        let e = FfiEngine(sink: self)
        try e.start(dataDir: dataDir, displayName: displayName, listenPort: UInt16(listenPort))
        self.engine = e
        resolve(nil)
      } catch { reject("E_ENGINE", String(describing: error), error) }
    }
  }

  @objc func pairingBundle(_ resolve: @escaping RCTPromiseResolveBlock,
                           reject: @escaping RCTPromiseRejectBlock) {
    run(resolve, reject) { try self.engine?.pairingBundle() }
  }

  @objc func pairWith(_ addr: String, bundleCbor: [NSNumber],
                      resolve: @escaping RCTPromiseResolveBlock,
                      reject: @escaping RCTPromiseRejectBlock) {
    let bytes = bundleCbor.map { UInt8(truncatingIfNeeded: $0.intValue) }
    run(resolve, reject) { try self.engine?.pairWith(addr: addr, bundleCbor: bytes) }
  }

  @objc func acceptPairing(_ resolve: @escaping RCTPromiseResolveBlock,
                           reject: @escaping RCTPromiseRejectBlock) {
    run(resolve, reject) { try self.engine?.acceptPairing() }
  }

  @objc func sendText(_ peerId: String, text: String,
                      resolve: @escaping RCTPromiseResolveBlock,
                      reject: @escaping RCTPromiseRejectBlock) {
    run(resolve, reject) { try self.engine?.sendText(peerId: peerId, text: text) }
  }

  @objc func sendFiles(_ peerId: String, paths: [String],
                       resolve: @escaping RCTPromiseResolveBlock,
                       reject: @escaping RCTPromiseRejectBlock) {
    run(resolve, reject) { try self.engine?.sendFiles(peerId: peerId, paths: paths) }
  }

  @objc func listDevices(_ resolve: @escaping RCTPromiseResolveBlock,
                         reject: @escaping RCTPromiseRejectBlock) {
    run(resolve, reject) { try self.engine?.listDevices() }
  }

  @objc func cancel(_ transferId: String,
                    resolve: @escaping RCTPromiseResolveBlock,
                    reject: @escaping RCTPromiseRejectBlock) {
    run(resolve, reject) { try self.engine?.cancel(transferId: transferId) }
  }

  @objc func retry(_ transferId: String,
                   resolve: @escaping RCTPromiseResolveBlock,
                   reject: @escaping RCTPromiseRejectBlock) {
    run(resolve, reject) { try self.engine?.retry(transferId: transferId) }
  }

  @objc func localPort(_ resolve: @escaping RCTPromiseResolveBlock,
                       reject: @escaping RCTPromiseRejectBlock) {
    run(resolve, reject) { self.engine?.localPort() }
  }

  @objc func shutdown(_ resolve: @escaping RCTPromiseResolveBlock,
                      reject: @escaping RCTPromiseRejectBlock) {
    let e = engine
    engine = nil
    run(resolve, reject) { try e?.shutdown() }
  }

  // UniFFI EventSink. Called on a Rust thread; RCTEventEmitter marshals to JS.
  func onEvent(eventJson: String) {
    sendEvent(withName: "DaakEvent", body: ["event": eventJson])
  }

  // Every engine call blocks on the engine's tokio runtime, so none of it runs
  // on the JS or main thread. `block` is `(FfiEngine?) throws -> T?`, which is
  // why each method above is one line. A nil engine resolves to nil; the JS
  // side has already guaranteed start() ran before any other call.
  private func run<T>(_ resolve: @escaping RCTPromiseResolveBlock,
                      _ reject: @escaping RCTPromiseRejectBlock,
                      _ block: @escaping () throws -> T?) {
    DispatchQueue.global().async {
      do { resolve(try block()) }
      catch { reject("E_DAAK", String(describing: error), error) }
    }
  }
}
