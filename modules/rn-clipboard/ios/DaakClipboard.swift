import Foundation
import React
import UIKit

/// UIPasteboard only. This is the paste side of an INBOUND text payload -- the
/// clipboard is the whole of what a text receipt does, and a paste needs no
/// permission, no keystore and no engine.
@objc(DaakClipboard)
class DaakClipboard: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool { true }

  @objc func setString(_ text: String,
                       resolve: @escaping RCTPromiseResolveBlock,
                       reject: @escaping RCTPromiseRejectBlock) {
    // UIPasteboard is main-thread-only, and this is called straight from the
    // engine.on handler, which is not on main.
    DispatchQueue.main.async { resolve(UIPasteboard.general.string = text) }
  }

  @objc func getString(_ resolve: @escaping RCTPromiseResolveBlock,
                       reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async { resolve(UIPasteboard.general.string ?? "") }
  }
}
