Pod::Spec.new do |s|
  s.name = "DaakTray"
  s.version = "0.1.0"
  s.summary = "Daak macOS status item tray"
  s.license = "MIT"
  s.authors = "Daak"
  s.homepage = "https://darshit.dev/daak"
  s.platforms = { :osx => "11.0" }
  s.source = { :git => "https://github.com/darshit/daak.git" }
  s.source_files = "macos/**/*.{mm,h}"
  s.dependency "React-Core"
end
