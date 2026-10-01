Pod::Spec.new do |s|
  s.name = "DaakSecureStore"
  s.version = "0.1.0"
  s.summary = "Daak OS keystore bridge (iOS Keychain)"
  s.license = "MIT"
  s.authors = "Daak"
  s.homepage = "https://darshit.dev/daak"
  s.platforms = { :ios => "16.0" }
  s.source = { :git => "https://github.com/darshit/daak.git" }
  # See DaakBgSched.podspec: the leading "ios/" resolved to a nonexistent
  # modules/rn-securestore/ios/ios/** and the pod compiled zero sources.
  s.source_files = "**/*.{swift,mm,h}"
  s.dependency "React-Core"
end
