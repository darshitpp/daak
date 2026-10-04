# THE ROOT PODSPEC, beside the iOS one in ios/. Same name, deliberately: it is the
# same module on a different platform, and CocoaPods is fine with the pair -- this
# is exactly the shape modules/rn-notify and modules/rn-share already use.
#
# It exists at all because the CLI's findPodspec globs '*.podspec' with cwd =
# PACKAGE ROOT and NO recursion, so it can never see ios/DaakSecureStore.podspec.
# Without a root spec the desktop app had no DaakSecureStore pod at all, and the
# desktop onboarding work below could not read or write the durable state it
# gates the engine start on. See rn-notify's root podspec for the measured
# version of the same finding.
#
# One spec covering both platforms rather than a macos/ subdirectory: the Swift
# below is ALREADY the macOS implementation, not an adaptation of the iOS one. The
# iOS file reaches for kSecUseDataProtectionKeychain, which macOS has no
# equivalent of -- the data-protection keychain is an iOS-13-and-later device
# concept and the constant is unavailable there -- so a shared source file has to
# ask for it only where it exists.
Pod::Spec.new do |s|
  s.name = "DaakSecureStore"
  s.version = "0.1.0"
  s.summary = "Daak OS keystore bridge (iOS/macOS Keychain)"
  s.license = "MIT"
  s.authors = "Daak"
  s.homepage = "https://darshit.dev/daak"
  # BOTH, not :osx alone: a spec that skipped iOS would make this file the one
  # the iOS app never links, which is the autolinking trap rn-notify's podspec
  # documents at length. Declaring both platforms means whichever app installs
  # it gets the same sources.
  s.platforms = { :ios => "16.0", :osx => "11.0" }
  s.source = { :git => "https://github.com/darshit/daak.git" }
  # 'ios/' with NO leading slash, matching the sibling specs: a leading path
  # resolved against ios/ and compiled zero sources (see the ios/ spec).
  s.source_files = "ios/**/*.{swift,mm,h}"
  s.dependency "React-Core"
end
