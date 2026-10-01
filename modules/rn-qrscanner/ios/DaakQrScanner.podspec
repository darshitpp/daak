Pod::Spec.new do |s|
  s.name = "DaakQrScanner"
  s.version = "0.1.0"
  s.summary = "Daak camera QR scanning and QR rendering"
  s.license = "MIT"
  s.authors = "Daak"
  s.homepage = "https://darshit.dev/daak"
  s.platforms = { :ios => "16.0" }
  s.source = { :git => "https://github.com/darshit/daak.git" }
  # See DaakBgSched.podspec: the leading "ios/" resolved to a nonexistent
  # modules/rn-qrscanner/ios/ios/** and the pod compiled zero sources. The glob
  # is deliberately not "*.swift": ScannerViewController.swift lives here too
  # and must be in the pod.
  s.source_files = "**/*.{swift,mm,h}"
  s.dependency "React-Core"
end
