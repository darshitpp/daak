import AppKit
import CoreImage
import Foundation
import React

/// The macOS HALF of the pairing QR: RENDER one, and nothing else.
///
/// A separate file rather than a shared one because ios/DaakQrScanner.swift
/// imports UIKit, which does not exist on macOS, and because the two platforms
/// do different jobs here. The phone is the side that scans: it owns the camera
/// and presents ScannerViewController. The desktop is the side that shows a code
/// and waits for the phone to scan it, so `scan` is deliberately absent -- a
/// camera permission prompt on a Mac that is only holding up a QR would ask for
/// a permission the app never uses.
///
/// The generator, the correction level and the scale-before-encode order are
/// copied from the iOS half rather than re-derived, because the two sides share
/// ONE capacity ceiling (packages/platform/src/qr.ts,
/// PAIRING_BUNDLE_BYTE_CEILING) and a host that rendered a weaker code would
/// refuse bundles the joiner can read.
@objc(DaakQrScanner)
class DaakQrScanner: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool { true }

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
    // NOT the iOS chain. The iOS half ends at UIImage(cgImage:).pngData().
    // On macOS the bitmap rep initializer is NON-optional, so binding it with
    // guard let is a compile error, not a runtime path. NSBitmapImageRep is
    // also the only PNG writer here: NSImage has no -representation(using:)
    // in this SDK.
    guard let output = filter.outputImage?
        .transformed(by: CGAffineTransform(scaleX: scale, y: scale)),
      let cg = CIContext().createCGImage(output, from: output.extent),
      let png = NSBitmapImageRep(cgImage: cg)
        .representation(using: .png, properties: [:]) else {
      reject("E_ENCODE", "qr encode failed", nil); return
    }
    resolve("data:image/png;base64," + png.base64EncodedString())
  }
}
