Pod::Spec.new do |s|
  s.name = "DaakFsPaths"
  s.version = "0.1.0"
  s.summary = "Daak sandbox path lookup and reveal"
  s.license = "MIT"
  s.authors = "Daak"
  s.homepage = "https://darshit.dev/daak"
  s.platforms = { :ios => "16.0" }
  s.source = { :git => "https://github.com/darshit/daak.git" }
  # See DaakBgSched.podspec: the leading "ios/" resolved to a nonexistent
  # modules/rn-fspaths/ios/ios/** and the pod compiled zero sources.
  s.source_files = "**/*.{swift,mm,h}"
  s.dependency "React-Core"
  s.frameworks = "QuickLook"
end
