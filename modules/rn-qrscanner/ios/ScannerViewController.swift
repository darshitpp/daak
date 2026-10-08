import AVFoundation
import UIKit

/// Full-screen camera UI for the scan half of QR pairing. Reports the FIRST
/// decoded QR payload via onResult, or an error via onError. One presentation,
/// one session: a second scan needs a fresh controller because the session
/// cannot usefully restart in place.
final class ScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
  private let session = AVCaptureSession()
  /// The visible half of this screen. A session with no preview layer runs the
  /// camera and draws NOTHING: the green LED lights and the screen stays black,
  /// which the user cannot tell apart from a dead camera.
  private var previewLayer: AVCaptureVideoPreviewLayer?
  private let onResult: (String) -> Void
  private let onError: (String) -> Void

  init(onResult: @escaping (String) -> Void,
       onError: @escaping (String) -> Void) {
    self.onResult = onResult
    self.onError = onError
    super.init(nibName: nil, bundle: nil)
  }
  required init?(coder: NSCoder) { fatalError("unused") }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    guard let device = AVCaptureDevice.default(for: .video),
          let input = try? AVCaptureDeviceInput(device: device),
          session.canAddInput(input) else {
      onError("camera unavailable"); return
    }
    session.addInput(input)
    let output = AVCaptureMetadataOutput()
    session.addOutput(output)
    output.setMetadataObjectsDelegate(self, queue: .main)
    output.metadataObjectTypes = [.qr]
    let preview = AVCaptureVideoPreviewLayer(session: session)
    preview.videoGravity = .resizeAspectFill
    view.layer.addSublayer(preview)
    previewLayer = preview
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    // Bounds, not frame: the layer hangs off view.layer, whose coordinate space
    // is the view's bounds.
    previewLayer?.frame = view.bounds
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    // startRunning blocks until the session is running; never on main.
    DispatchQueue.global(qos: .userInitiated).async { self.session.startRunning() }
  }

  func metadataOutput(_ output: AVCaptureMetadataOutput,
                      didOutput objects: [AVMetadataObject],
                      from connection: AVCaptureConnection) {
    guard let readable = objects
      .compactMap({ $0 as? AVMetadataMachineReadableCodeObject })
      .first,
      let value = readable.stringValue else { return }
    session.stopRunning()
    onResult(value)
  }
}
