Pod::Spec.new do |s|
  s.name = "DaakClipboard"
  s.version = "0.1.0"
  s.summary = "Daak system clipboard"
  s.license = "MIT"
  s.authors = "Daak"
  s.homepage = "https://darshit.dev/daak"
  s.platforms = { :ios => "16.0" }
  s.source = { :git => "https://github.com/darshit/daak.git" }
  s.source_files = "ios/**/*.{swift,mm,h}"
  s.dependency "React-Core"
end
