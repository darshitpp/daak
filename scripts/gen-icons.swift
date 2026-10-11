// Draws the Daak mark into every icon file. Output paths are fixed below.
// The geometry is the path data of daak-logo.svg. The script uses no other tool.
// Usage: swift scripts/gen-icons.swift <repo-root>
// Run it through scripts/gen-icons.sh, which sets the scratch directory.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// Units of the SVG. The viewBox is 3.5 4.75 13.5 14.5. The stroke is 1.75 wide.
// So the ink box is 2.625 .. 17.875 by 3.875 .. 20.125.
let inkCenter = CGPoint(x: 10.25, y: 12)
let inkHeight: CGFloat = 16.25
let viewBox = CGRect(x: 3.5, y: 4.75, width: 13.5, height: 14.5)
let strokeWidth: CGFloat = 1.75
let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
func rgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat) -> CGColor {
    CGColor(colorSpace: srgb, components: [r / 255, g / 255, b / 255, 1])!
}
let cream = rgb(247, 244, 237)
let ink = rgb(28, 28, 28)
let black = rgb(0, 0, 0)
let edge = rgb(228, 223, 210)

func markPaths() -> [CGPath] {
    let k: CGFloat = 0.5522847498 * 7.25
    let d = CGMutablePath()
    d.move(to: CGPoint(x: 3.5, y: 4.75))
    d.addLine(to: CGPoint(x: 9.75, y: 4.75))
    d.addCurve(to: CGPoint(x: 17, y: 12), control1: CGPoint(x: 9.75 + k, y: 4.75), control2: CGPoint(x: 17, y: 12 - k))
    d.addCurve(to: CGPoint(x: 9.75, y: 19.25), control1: CGPoint(x: 17, y: 12 + k), control2: CGPoint(x: 9.75 + k, y: 19.25))
    d.addLine(to: CGPoint(x: 3.5, y: 19.25))
    d.closeSubpath()
    let v = CGMutablePath()
    v.move(to: CGPoint(x: 5.25, y: 9))
    v.addLine(to: CGPoint(x: 9.75, y: 13.2))
    v.addLine(to: CGPoint(x: 14.36, y: 9))
    return [d, v]
}

/// Draw the mark. `s` is the pixel count for each SVG unit. `at` is where the
/// centre of the ink box lands, in y-down pixels. `clip` cuts at the viewBox.
func drawMark(_ c: CGContext, s: CGFloat, at: CGPoint, color: CGColor, clip: Bool = false) {
    c.saveGState()
    c.translateBy(x: at.x - inkCenter.x * s, y: at.y - inkCenter.y * s)
    c.scaleBy(x: s, y: s)
    if clip { c.clip(to: viewBox) }
    c.setStrokeColor(color)
    c.setLineWidth(strokeWidth)
    c.setLineCap(.round)
    c.setLineJoin(.round)
    for p in markPaths() {
        c.addPath(p)
        c.strokePath()
    }
    c.restoreGState()
}

/// A y-down bitmap. `opaque` gives a PNG with no alpha channel.
func render(_ w: Int, _ h: Int, opaque: Bool, _ body: (CGContext) -> Void) -> CGImage {
    let info = opaque ? CGImageAlphaInfo.noneSkipLast.rawValue : CGImageAlphaInfo.premultipliedLast.rawValue
    let c = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                      space: srgb, bitmapInfo: info)!
    c.setAllowsAntialiasing(true)
    c.setShouldAntialias(true)
    c.translateBy(x: 0, y: CGFloat(h))
    c.scaleBy(x: 1, y: -1)
    body(c)
    return c.makeImage()!
}

func write(_ img: CGImage, _ url: URL) {
    try! FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let d = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(d, img, nil)
    precondition(CGImageDestinationFinalize(d), "cannot write \(url.path)")
}

/// The app icon layout of `daak-app-icon.svg` in the design project. The group
/// is `translate(102 20) scale(40)` on a 1024 canvas. So one SVG unit is 40/1024
/// of the tile edge, and the ink box centre sits at x = 512, y = 500 (12 px
/// above the middle). The path box is 540 x 580 px and the stroke adds 35 px on
/// each side, so the ink box is 610 x 650 px.
let iconUnit: CGFloat = 40.0 / 1024.0
let iconCenterY: CGFloat = 500.0 / 1024.0

/// Draw the mark inside a square `box` with the layout above.
func drawIconMark(_ c: CGContext, in box: CGRect, color: CGColor) {
    drawMark(c, s: iconUnit * box.width,
             at: CGPoint(x: box.midX, y: box.minY + iconCenterY * box.height), color: color)
}

func tile(_ c: CGContext, _ r: CGRect, radius: CGFloat, fill: CGColor, line: CGColor? = nil, lineWidth: CGFloat = 0) {
    let p = CGPath(roundedRect: r, cornerWidth: radius, cornerHeight: radius, transform: nil)
    c.setFillColor(fill)
    c.addPath(p)
    c.fillPath()
    if let line = line {
        c.setStrokeColor(line)
        c.setLineWidth(lineWidth)
        c.addPath(p)
        c.strokePath()
    }
}

func contents(_ rows: [String]) -> String {
    "{\n  \"images\" : [\n" + rows.joined(separator: ",\n") +
    "\n  ],\n  \"info\" : {\n    \"author\" : \"xcode\",\n    \"version\" : 1\n  }\n}\n"
}

let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
func out(_ rel: String) -> URL { root.appendingPathComponent(rel) }

// The Wordmark mark is the embedded PNG data URI in packages/ui/src/assets/mark.ts.
// Check it BEFORE any write, so a stale embed fails before the script touches an
// icon. Redraw it at the embedded size 92 x 98, the whole ink box. Do not compare the encoded
// bytes, because two encoders can differ; compare the decoded pixel size and the
// alpha channel only. This writes no file.
let markTs = try! String(contentsOf: out("packages/ui/src/assets/mark.ts"), encoding: .utf8)
let markW = 92, markH = 98
let markScale: CGFloat = 6
let markPng = render(markW, markH, opaque: false) { c in
    drawMark(c, s: markScale,
             at: CGPoint(x: CGFloat(markW) / 2, y: CGFloat(markH) / 2),
             color: ink)
}
let markPrefix = "data:image/png;base64,"
let markParts = markTs.components(separatedBy: markPrefix)
precondition(markParts.count > 1, "mark.ts holds no png data URI")
let base64 = markParts[1].prefix { $0.isLetter || $0.isNumber || $0 == "+" || $0 == "/" || $0 == "=" }
guard let embedded = Data(base64Encoded: String(base64)),
      let src = CGImageSourceCreateWithData(embedded as CFData, nil),
      let embeddedMark = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    preconditionFailure("mark.ts png data URI does not decode")
}
precondition(embeddedMark.width == markW && embeddedMark.height == markH,
             "mark.ts is \(embeddedMark.width) x \(embeddedMark.height), not \(markW) x \(markH)")
precondition(embeddedMark.alphaInfo != .none && markPng.alphaInfo != .none,
             "the mark must keep an alpha channel")

// iOS. A full square with no alpha. The system applies the corner mask.
// The size 1024 matches daak-app-icon.svg pixel for pixel (Task 2 Step 3).
let iosDir = "apps/mobile/ios/Daak/Images.xcassets/AppIcon.appiconset"
let iosEntries: [(size: String, scale: Int, px: Int, idiom: String)] = [
    ("20x20", 2, 40, "iphone"), ("20x20", 3, 60, "iphone"),
    ("29x29", 2, 58, "iphone"), ("29x29", 3, 87, "iphone"),
    ("40x40", 2, 80, "iphone"), ("40x40", 3, 120, "iphone"),
    ("60x60", 2, 120, "iphone"), ("60x60", 3, 180, "iphone"),
    ("1024x1024", 1, 1024, "ios-marketing"),
]
var iosRows: [String] = []
for e in iosEntries {
    let n = CGFloat(e.px)
    write(render(e.px, e.px, opaque: true) { c in
        c.setFillColor(cream)
        c.fill(CGRect(x: 0, y: 0, width: n, height: n))
        drawIconMark(c, in: CGRect(x: 0, y: 0, width: n, height: n), color: ink)
    }, out("\(iosDir)/icon-\(e.px).png"))
    iosRows.append("    {\n      \"filename\" : \"icon-\(e.px).png\",\n      \"idiom\" : \"\(e.idiom)\",\n      \"scale\" : \"\(e.scale)x\",\n      \"size\" : \"\(e.size)\"\n    }")
}
try! contents(iosRows).write(to: out("\(iosDir)/Contents.json"), atomically: true, encoding: .utf8)

// macOS. A rounded tile with a margin of 100 px on 1024, and a hairline edge.
// The mark has the same layout inside the tile as on iOS.
let macDir = "apps/desktop/macos/Daak-macOS/Assets.xcassets/AppIcon.appiconset"
let macEntries: [(pt: Int, scale: Int)] = [
    (16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2),
]
var macRows: [String] = []
for e in macEntries {
    let px = e.pt * e.scale
    let n = CGFloat(px)
    let t = n * 824 / 1024
    let r = CGRect(x: (n - t) / 2, y: (n - t) / 2, width: t, height: t)
    write(render(px, px, opaque: false) { c in
        tile(c, r, radius: t * 0.225, fill: cream, line: edge, lineWidth: max(1, n / 256))
        drawIconMark(c, in: r, color: ink)
    }, out("\(macDir)/icon_\(e.pt)x\(e.pt)@\(e.scale)x.png"))
    macRows.append("    {\n      \"filename\" : \"icon_\(e.pt)x\(e.pt)@\(e.scale)x.png\",\n      \"idiom\" : \"mac\",\n      \"scale\" : \"\(e.scale)x\",\n      \"size\" : \"\(e.pt)x\(e.pt)\"\n    }")
}
try! contents(macRows).write(to: out("\(macDir)/Contents.json"), atomically: true, encoding: .utf8)

// macOS menu bar. Black on transparent, 18 pt. Contents.json sets the template flag.
let barDir = "apps/desktop/macos/Daak-macOS/Assets.xcassets/MenuBarIcon.imageset"
for scale in [1, 2] {
    let px = 18 * scale
    let n = CGFloat(px)
    write(render(px, px, opaque: false) { c in
        drawMark(c, s: (16 * CGFloat(scale)) / inkHeight, at: CGPoint(x: n / 2, y: n / 2), color: black)
    }, out("\(barDir)/menubar-\(px).png"))
}
let barJson = """
{
  "images" : [
    {
      "filename" : "menubar-18.png",
      "idiom" : "universal",
      "scale" : "1x"
    },
    {
      "filename" : "menubar-36.png",
      "idiom" : "universal",
      "scale" : "2x"
    }
  ],
  "info" : {
    "author" : "xcode",
    "version" : 1
  },
  "properties" : {
    "template-rendering-intent" : "template"
  }
}

"""
try! barJson.write(to: out("\(barDir)/Contents.json"), atomically: true, encoding: .utf8)

// Android. The value is the pixel count for each dp.
let res = "apps/mobile/android/app/src/main/res"
let densities: [(name: String, px: CGFloat)] = [
    ("mdpi", 1), ("hdpi", 1.5), ("xhdpi", 2), ("xxhdpi", 3), ("xxxhdpi", 4),
]
for d in densities {
    let f = d.px
    // Adaptive foreground. The canvas is 108 dp. The visible area is 72 dp.
    // The design layout fills a 72 dp box in the middle, so the ink box is
    // 42.9 x 45.7 dp. Its farthest point is 31 dp from the middle. That fits in
    // the 66 dp circle (radius 33 dp) that every mask keeps.
    let fg = Int(108 * f)
    let box = CGRect(x: 18 * f, y: 18 * f, width: 72 * f, height: 72 * f)
    write(render(fg, fg, opaque: false) { c in
        drawIconMark(c, in: box, color: ink)
    }, out("\(res)/mipmap-\(d.name)/ic_launcher_foreground.png"))
    // Legacy icons. The canvas is 48 dp.
    let n = Int(48 * f)
    let nn = CGFloat(n)
    let inset = 2 * f
    let t = nn - 2 * inset
    let r = CGRect(x: inset, y: inset, width: t, height: t)
    write(render(n, n, opaque: false) { c in
        tile(c, r, radius: 8 * f, fill: cream)
        drawIconMark(c, in: r, color: ink)
    }, out("\(res)/mipmap-\(d.name)/ic_launcher.png"))
    write(render(n, n, opaque: false) { c in
        tile(c, r, radius: t / 2, fill: cream)
        drawIconMark(c, in: r, color: ink)
    }, out("\(res)/mipmap-\(d.name)/ic_launcher_round.png"))
}

