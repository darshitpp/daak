Pod::Spec.new do |s|
  s.name = "DaakClipboard"
  s.version = "0.1.0"
  s.summary = "Daak system clipboard"
  s.license = "MIT"
  s.authors = "Daak"
  s.homepage = "https://darshit.dev/daak"
  s.platforms = { :ios => "16.0" }
  s.source = { :git => "https://github.com/darshit/daak.git" }
  # See DaakBgSched.podspec: the leading "ios/" resolved to a nonexistent
  # modules/rn-clipboard/ios/ios/** and the pod compiled zero sources.
  # NOTE: CocoaPods only reaches the "Unable to determine Swift version" abort
  # when NOTHING matches; a glob that matches no .swift never trips it. That is
  # why this pod installed cleanly while building nothing -- and why the fix
  # needs no s.swift_version (the app target sets SWIFT_VERSION = 5.0).
  s.source_files = "**/*.{swift,mm,h}"
  s.dependency "React-Core"
end
