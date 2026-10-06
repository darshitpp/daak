Pod::Spec.new do |s|
  s.name = "DaakFsPaths"
  s.version = "0.1.0"
  s.summary = "Daak sandbox path lookup, reveal, and the download folder"
  s.license = "MIT"
  s.authors = "Daak"
  s.homepage = "https://darshit.dev/daak"
  # macOS 14 matches the app target. The iOS podspec has an `:ios` platform and
  # macOS has no fallback, so a pod with no `:osx` entry is not built here at
  # all -- which is why the desktop had no fspaths module and therefore no
  # reveal and no download folder.
  s.platforms = { :osx => "14.0" }
  s.source = { :git => "https://github.com/darshit/daak.git" }
  s.source_files = "**/*.{swift,mm,h}"
  s.dependency "React-Core"
end
