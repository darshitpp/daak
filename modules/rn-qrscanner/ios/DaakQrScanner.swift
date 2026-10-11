import CoreImage
import React
import UIKit

/// The QR half of pairing: render a payload into a PNG data URI, and present
/// the camera to scan one back. Deliberately a POD (R94) -- the scanner is
/// only reachable from JS after the bridge is up, so nothing here needs to
/// exist at app launch, unlike DaakBgLaunch/DaakNotificationDelegate.
/// Neither method touches the transport: pairing is `engine.pair` over the
/// FFI, and the outbox owns every Daak-to-Daak transfer.
@objc(DaakQrScanner)
class DaakQrScanner: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool { true }

  @objc func scan(_ resolve: @escaping RCTPromiseResolveBlock,
                  reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      guard let root = Self.rootViewController() else {
        reject("E_NO_VC", "no root view controller", nil); return
      }
      // Every way out dismisses the camera screen first. It was a full-screen
      // black view with no control, and an error used to reject the promise
      // and leave that view up.
      let vc = ScannerViewController(
        onResult: { [weak root] value in
          root?.dismiss(animated: true) { resolve(value) }
        },
        onError: { [weak root] message in
          root?.dismiss(animated: true) { reject("E_CAMERA", message, nil) }
        },
        onCancel: { [weak root] in
          root?.dismiss(animated: true) { reject("E_SCAN_CANCELLED", "scan cancelled", nil) }
        })
      vc.modalPresentationStyle = .fullScreen
      root.present(vc, animated: true)
    }
  }

  @objc func generate(_ payload: String, size: NSNumber,
                      resolve: @escaping RCTPromiseResolveBlock,
                      reject: @escaping RCTPromiseRejectBlock) {
    guard let filter = CIFilter(name: "CIQRCodeGenerator") else {
      reject("E_FILTER", "CIQRCodeGenerator unavailable", nil); return
    }
    filter.setValue(Data(payload.utf8), forKey: "inputMessage")
    filter.setValue("M", forKey: "inputCorrectionLevel")
    // CIQRCodeGenerator's output is a small fixed-size matrix. Scale it BEFORE
    // createCGImage, or the data URI is a blurry 32px dot no camera can read.
    let scale = max(1, size.doubleValue / 32)
    guard let output = filter.outputImage?
        .transformed(by: CGAffineTransform(scaleX: scale, y: scale)),
      let cg = CIContext().createCGImage(output, from: output.extent),
      let data = UIImage(cgImage: cg).pngData() else {
      reject("E_ENCODE", "qr encode failed", nil); return
    }
    resolve("data:image/png;base64," + data.base64EncodedString())
  }

  // Same helper DaakShare uses: the RN root view controller, not a scene walk
  // that can be asked before any window is key.
  private static func rootViewController() -> UIViewController? {
    UIApplication.shared.connectedScenes
      .compactMap { ($0 as? UIWindowScene)?.keyWindow }
      .first?.rootViewController
  }
}
