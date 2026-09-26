// 앱 아이콘: 둥근 사각 바탕에 받은편지함(tray.full) 심볼. SwiftPM만으로 만들기 위해 CoreGraphics로 그린다.
import AppKit

let sizes = [16, 32, 64, 128, 256, 512, 1024]
let out = URL(fileURLWithPath: CommandLine.arguments[1])
try? FileManager.default.removeItem(at: out)
try! FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

func render(_ px: Int) -> Data {
  let image = NSImage(size: NSSize(width: px, height: px))
  image.lockFocus()
  let rect = NSRect(x: 0, y: 0, width: px, height: px)
  let inset = CGFloat(px) * 0.08
  let path = NSBezierPath(roundedRect: rect.insetBy(dx: inset, dy: inset), xRadius: CGFloat(px) * 0.22, yRadius: CGFloat(px) * 0.22)
  let gradient = NSGradient(colors: [NSColor(calibratedRed: 0.16, green: 0.36, blue: 0.92, alpha: 1), NSColor(calibratedRed: 0.10, green: 0.22, blue: 0.62, alpha: 1)])!
  gradient.draw(in: path, angle: -90)
  let config = NSImage.SymbolConfiguration(pointSize: CGFloat(px) * 0.52, weight: .medium)
  if let symbol = NSImage(systemSymbolName: "tray.full.fill", accessibilityDescription: nil)?.withSymbolConfiguration(config) {
    let tinted = NSImage(size: symbol.size, flipped: false) { r in
      symbol.draw(in: r)
      NSColor.white.set()
      r.fill(using: .sourceAtop)
      return true
    }
    let s = tinted.size
    tinted.draw(in: NSRect(x: (CGFloat(px) - s.width) / 2, y: (CGFloat(px) - s.height) / 2 + CGFloat(px) * 0.02, width: s.width, height: s.height))
  }
  image.unlockFocus()
  let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
  return rep.representation(using: .png, properties: [:])!
}

for size in sizes {
  try! render(size).write(to: out.appendingPathComponent("icon_\(size)x\(size).png"))
  if size <= 512 { try! render(size * 2).write(to: out.appendingPathComponent("icon_\(size)x\(size)@2x.png")) }
}
print("iconset: \(out.path)")
