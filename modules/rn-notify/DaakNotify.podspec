# THE ROOT PODSPEC, at modules/rn-notify/DaakNotify.podspec, beside the Phase 5
# one in ios/. Same name, deliberately: it is the same module on a different
# platform. CocoaPods is fine with the pair. Measured, not assumed:
#
#   1. The RN CLI findPodspec globs '*.podspec' with cwd = PACKAGE ROOT and no
#      recursion (cli-config-apple/build/config/findPodspec.js), so it could
#      never see ios/DaakNotify.podspec. Verified by running the CLI from
#      apps/desktop: before this file, @daak/rn-notify had NO podspec entry at
#      all, while @daak/rn-share and @daak/rn-tray each resolved one. Same as
#      the other Phase 5 modules (ledger D5-5).
#   2. findPodspec's preferred name is basename(folder) + '.podspec', which is
#      'rn-notify.podspec' and absent, so the glob result -- this file -- is what
#      autolinking resolves. This spec is THE spec the CLI sees.
#   3. Because it declares only :osx, an iOS pod install SKIPS it:
#      use_native_modules! does 'next unless spec.supported_on_platform?(
#      platform.name)' (cli-platform-ios/native_modules.rb).
#
# CONSEQUENCE, stated plainly because an earlier version of this comment got it
# wrong: mobile's notification surface is NOT linked by this spec, and is NOT
# made any worse by it. ios/DaakNotify.podspec was ALREADY invisible to
# autolinking (point 1), so nothing that worked before stops working. What is
# already broken is that packages/platform/src/notify.ts imports @daak/rn-notify
# and no iOS pod was ever resolved for it. A mobile native build of that surface
# is unproven either way, and this file neither introduces nor repairs that.
#
# THIS IS A KNOWN, PRE-EXISTING, REPO-WIDE AUTOLINKING DEFECT. It is NOT
# introduced or repaired here. @daak/rn-share has the identical shape -- a root
# DaakShare.podspec (:osx) beside an ios/DaakShare.podspec (:ios) -- so the same
# iOS skip applies to it. This is the repo-wide ledger D1/D5-5 item.
#
# Deliberately NOT fixed in this file, all of it out of scope on purpose: renaming
# the pod, adding a second podspec, editing apps/mobile/ios/Podfile, or folding
# both platforms into one spec. That fix belongs to the ledger and to whichever
# phase owns the iOS autolinking contract, not to a task whose whole subject is a
# macOS notification centre.

Pod::Spec.new do |s|
  s.name = "DaakNotify"
  s.version = "0.1.0"
  s.summary = "Daak macOS received-payload notifications with action buttons"
  s.license = "MIT"
  s.authors = "Daak"
  s.homepage = "https://darshit.dev/daak"
  s.platforms = { :osx => "11.0" }
  s.source = { :git => "https://github.com/darshit/daak.git" }
  s.source_files = "macos/**/*.{mm,h}"
  s.dependency "React-Core"
end
