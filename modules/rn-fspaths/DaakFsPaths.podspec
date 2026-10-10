# THE ROOT PODSPEC, beside ios/DaakFsPaths.podspec. Same name, deliberately:
# the same module on a different platform, exactly as DaakQrScanner and
# DaakSecureStore do. It exists because the RN CLI's findPodspec globs
# '*.podspec' with cwd = PACKAGE ROOT and NO recursion, so a spec under
# macos/ or ios/ is never found on its own. Without this file the desktop
# linked no fspaths pod at all.
#
# BOTH platforms declared. A spec that declared only :osx would make THIS the
# file the iOS app never links, because use_native_modules! skips a spec whose
# supported_on_platform? is false and it evaluates the spec it FOUND, which is
# always this one.
#
# PER-PLATFORM source_files, not one glob: the two halves do not compile
# together, because the macOS half imports AppKit and the iOS half imports
# React alone.
Pod::Spec.new do |s|
  s.name = "DaakFsPaths"
  s.version = "0.1.0"
  s.summary = "Daak sandbox path lookup, reveal, and the download folder"
  s.license = "MIT"
  s.authors = "Daak"
  s.homepage = "https://darshit.dev/daak"
  s.platforms = { :ios => "16.0", :osx => "14.0" }
  s.source = { :git => "https://github.com/darshit/daak.git" }
  s.ios.source_files = "ios/**/*.{swift,mm,h}"
  s.osx.source_files = "macos/**/*.{swift,mm,h}"
  s.dependency "React-Core"
  # AppKit is the macOS spelling of the iOS frameworks these sources use, and
  # `reveal` calls NSWorkspace. Without it the pod's object file carries UN*
  # references the app target never links.
  s.osx.frameworks = "AppKit"
  # QLPreviewController, used by openFile on iOS.
  s.ios.frameworks = "QuickLook"
end
