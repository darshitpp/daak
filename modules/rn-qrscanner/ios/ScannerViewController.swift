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
  /// The user left the camera screen without a code. The presenter dismisses
  /// this view and reports a cancellation.
  private let onCancel: () -> Void

  init(onResult: @escaping (String) -> Void,
       onError: @escaping (String) -> Void,
       onCancel: @escaping () -> Void) {
    self.onResult = onResult
    self.onError = onError
    self.onCancel = onCancel
    super.init(nibName: nil, bundle: nil)
  }
  required init?(coder: NSCoder) { fatalError("unused") }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    addCancelButton()
    // A denied or restricted camera draws a black screen and runs nothing.
    // Say so at once, so the presenter can dismiss this view.
    let access = AVCaptureDevice.authorizationStatus(for: .video)
    if access == .denied || access == .restricted {
      onError("camera permission denied"); return
    }
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
    // At the back: the Cancel button is already a subview, and a layer added on
    // top of it would hide it.
    view.layer.insertSublayer(preview, at: 0)
    previewLayer = preview
  }

  /// A visible way out. The screen is full screen and shows only the camera,
  /// so without this the user could not leave it.
  private func addCancelButton() {
    let button = UIButton(type: .system)
    button.setTitle("Cancel", for: .normal)
    button.setTitleColor(.white, for: .normal)
    button.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
    button.backgroundColor = UIColor.black.withAlphaComponent(0.5)
    button.layer.cornerRadius = 18
    button.contentEdgeInsets = UIEdgeInsets(top: 8, left: 16, bottom: 8, right: 16)
    button.accessibilityLabel = "Cancel scanning"
    button.translatesAutoresizingMaskIntoConstraints = false
    button.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
    view.addSubview(button)
    NSLayoutConstraint.activate([
      button.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
      button.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
    ])
  }

  @objc private func cancelTapped() {
    // stopRunning blocks until the session has stopped; never on main.
    let session = self.session
    DispatchQueue.global(qos: .userInitiated).async { session.stopRunning() }
    onCancel()
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
