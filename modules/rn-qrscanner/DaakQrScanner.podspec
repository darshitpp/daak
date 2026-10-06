# THE ROOT PODSPEC, beside ios/DaakQrScanner.podspec. Same name, deliberately:
# the same module on a different platform, and CocoaPods is fine with the pair.
# It exists at all for the reason modules/rn-securestore/DaakSecureStore.podspec
# spells out at length: the RN CLI findPodspec globs '*.podspec' with cwd =
# PACKAGE ROOT and NO recursion, so it can never see ios/DaakQrScanner.podspec.
#
# BOTH platforms declared, like that securestore spec. A spec that declared
# only :osx would make THIS the file the iOS app never links, because
# use_native_modules! skips any spec whose supported_on_platform? is false, and
# it evaluates the spec it FOUND -- which is always the root one.
#
# PER-PLATFORM source_files, not one glob over both. The two halves do not
# compile together: ios/DaakQrScanner.swift imports UIKit and
# ios/ScannerViewController.swift imports AVFoundation, and macOS has no UIKit.
# This is the documented CocoaPods shape: s.ios.source_files alongside
# s.osx.source_files.
Pod::Spec.new do |s|
  s.name = "DaakQrScanner"
  s.version = "0.1.0"
  s.summary = "Daak QR rendering (macOS) and scanning plus rendering (iOS)"
  s.license = "MIT"
  s.authors = "Daak"
  s.homepage = "https://darshit.dev/daak"
  s.platforms = { :ios => "16.0", :osx => "11.0" }
  s.source = { :git => "https://github.com/darshit/daak.git" }
  # 'ios/' with NO leading slash, matching every sibling spec: a leading path
  # resolved against the spec root again and the pod compiled zero sources.
  s.ios.source_files = "ios/**/*.{swift,mm,h}"
  s.osx.source_files = "macos/**/*.{swift,mm,h}"
  s.dependency "React-Core"
  # CoreImage is the macOS spelling of the iOS generator. Without this the pod's
  # own object file carries UN* references the app target never links, which is
  # the same failure modules/rn-notify/DaakNotify.podspec records for
  # UserNotifications.
  s.frameworks = "CoreImage"
end
