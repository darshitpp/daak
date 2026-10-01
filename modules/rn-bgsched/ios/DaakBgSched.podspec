Pod::Spec.new do |s|
  s.name = "DaakBgSched"
  s.version = "0.1.0"
  s.summary = "Daak background execution: BGTaskScheduler, foreground service, WorkManager"
  s.license = "MIT"
  s.authors = "Daak"
  s.homepage = "https://darshit.dev/daak"
  s.platforms = { :ios => "16.0" }
  s.source = { :git => "https://github.com/darshit/daak.git" }
  # Relative to THIS podspec's directory, which is already modules/rn-bgsched/ios
  # (react-native.config.js points podspecPath here). The leading "ios/" made it
  # resolve to modules/rn-bgsched/ios/ios/**, which does not exist: the pod
  # compiled ZERO sources and linked an empty libDaakBgSched.a, so
  # getEnforcing('DaakBgSched') threw at launch on 2026-10-01.
  s.source_files = "**/*.{swift,mm,h}"
  s.dependency "React-Core"
end
