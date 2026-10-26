// Draws the app icon (graphite tile with the Keepwatch mark) as a PNG set
// for iconutil. Usage: MakeIcon <target.iconset>
import AppKit
import CoreGraphics

let out = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.iconset")
try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

func rgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: a)
}

func draw(_ px: Int) -> Data {
    let cs = CGColorSpace(name: CGColorSpace.sRGB)!
    let ctx = CGContext(data: nil, width: px, height: px, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let k = CGFloat(px) / 1024
    ctx.scaleBy(x: k, y: k)
    // Coordinates from the top left, like in the design
    ctx.translateBy(x: 0, y: 1024)
    ctx.scaleBy(x: 1, y: -1)

    // macOS grid: 824 x 824 at 100, radius ~185
    let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
    let path = CGPath(roundedRect: tile, cornerWidth: 186, cornerHeight: 186, transform: nil)

    // Shadow
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: 18), blur: 30, color: rgb(0, 0, 0, 0.42))
    ctx.addPath(path); ctx.setFillColor(rgb(10, 10, 11)); ctx.fillPath()
    ctx.restoreGState()

    ctx.saveGState()
    ctx.addPath(path); ctx.clip()
    // Graphite, lighter at the top
    let base = CGGradient(colorsSpace: cs, colors: [rgb(38, 38, 42), rgb(14, 14, 16), rgb(6, 6, 7)] as CFArray, locations: [0, 0.55, 1])!
    ctx.drawLinearGradient(base, start: CGPoint(x: 512, y: 100), end: CGPoint(x: 512, y: 924), options: [])
    // Light from above
    let light = CGGradient(colorsSpace: cs, colors: [rgb(210, 212, 235, 0.22), rgb(210, 212, 235, 0)] as CFArray, locations: [0, 1])!
    ctx.drawRadialGradient(light, startCenter: CGPoint(x: 512, y: 60), startRadius: 0, endCenter: CGPoint(x: 512, y: 60), endRadius: 620, options: [])
    // Dot grid
    ctx.setFillColor(rgb(255, 255, 255, 0.07))
    var y: CGFloat = 122
    while y < 924 {
        var x: CGFloat = 122
        while x < 924 {
            let fade = max(0, 1 - (y - 100) / 824 * 1.2)
            if fade > 0 {
                ctx.setFillColor(rgb(255, 255, 255, 0.09 * fade))
                ctx.fillEllipse(in: CGRect(x: x - 2.4, y: y - 2.4, width: 4.8, height: 4.8))
            }
            x += 44
        }
        y += 44
    }
    // Lavender glow behind the mark
    let glow = CGGradient(colorsSpace: cs, colors: [rgb(163, 163, 255, 0.34), rgb(163, 163, 255, 0)] as CFArray, locations: [0, 1])!
    ctx.drawRadialGradient(glow, startCenter: CGPoint(x: 512, y: 560), startRadius: 0, endCenter: CGPoint(x: 512, y: 560), endRadius: 360, options: [])
    ctx.restoreGState()

    // Glass edge: 1 px light at the top, dark at the bottom
    ctx.saveGState()
    ctx.addPath(path)
    ctx.setLineWidth(4)
    ctx.replacePathWithStrokedPath()
    ctx.clip()
    let edge = CGGradient(colorsSpace: cs, colors: [rgb(255, 255, 255, 0.34), rgb(255, 255, 255, 0.06), rgb(255, 255, 255, 0.02)] as CFArray, locations: [0, 0.35, 1])!
    ctx.drawLinearGradient(edge, start: CGPoint(x: 512, y: 100), end: CGPoint(x: 512, y: 924), options: [])
    ctx.restoreGState()

    // Mark (24-unit grid from Shell.tsx), 23.5 px per unit, centered
    let s: CGFloat = 23.5
    let ox = 512 - 12 * s, oy = 528 - 12 * s
    func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: ox + x * s, y: oy + y * s) }
    func poly(_ pts: [CGPoint]) -> CGPath { let m = CGMutablePath(); m.addLines(between: pts); m.closeSubpath(); return m }

    let gem = poly([p(12, 1.5), p(21, 8), p(12, 22.5), p(3, 8)])
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: 22), blur: 40, color: rgb(0, 0, 0, 0.7))
    ctx.addPath(gem); ctx.setFillColor(rgb(60, 60, 64)); ctx.fillPath()
    ctx.restoreGState()
    ctx.saveGState()
    ctx.setShadow(offset: .zero, blur: 50, color: rgb(205, 205, 255, 0.35))
    ctx.addPath(gem); ctx.clip()
    let a = CGGradient(colorsSpace: cs, colors: [rgb(255, 255, 255), rgb(166, 166, 172), rgb(44, 44, 48)] as CFArray, locations: [0, 0.55, 1])!
    ctx.drawLinearGradient(a, start: p(3, 1.5), end: p(21, 22.5), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    ctx.restoreGState()

    ctx.saveGState()
    ctx.addPath(poly([p(12, 1.5), p(21, 8), p(12, 11.2)])); ctx.clip()
    let b = CGGradient(colorsSpace: cs, colors: [rgb(228, 228, 240, 0.92), rgb(26, 26, 30, 0.92)] as CFArray, locations: [0, 1])!
    ctx.drawLinearGradient(b, start: p(21, 1.5), end: p(9, 14), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    ctx.restoreGState()

    ctx.addPath(poly([p(12, 11.2), p(21, 8), p(12, 22.5)]))
    ctx.setFillColor(rgb(20, 20, 26, 0.55)); ctx.fillPath()

    // fine light edges of the facets
    ctx.setLineWidth(2.2)
    ctx.setStrokeColor(rgb(255, 255, 255, 0.55))
    ctx.move(to: p(3, 8)); ctx.addLine(to: p(12, 1.5)); ctx.addLine(to: p(21, 8)); ctx.strokePath()
    ctx.setStrokeColor(rgb(205, 205, 255, 0.35))
    ctx.move(to: p(12, 11.2)); ctx.addLine(to: p(12, 22.5)); ctx.strokePath()

    let img = ctx.makeImage()!
    let rep = NSBitmapImageRep(cgImage: img)
    return rep.representation(using: .png, properties: [:])!
}

let sizes: [(String, Int)] = [
    ("icon_16x16", 16), ("icon_16x16@2x", 32), ("icon_32x32", 32), ("icon_32x32@2x", 64),
    ("icon_128x128", 128), ("icon_128x128@2x", 256), ("icon_256x256", 256), ("icon_256x256@2x", 512),
    ("icon_512x512", 512), ("icon_512x512@2x", 1024),
]
for (name, px) in sizes {
    try! draw(px).write(to: out.appendingPathComponent("\(name).png"))
}
print("Icon drawn: \(out.path)")
