// dmg 창 배경. 앱을 끌어 넣는 그림과, 처음 열 때 막히면 어디를 눌러야 하는지를 창 안에 바로 적어 둔다.
// Finder 아이콘 위치(build.sh의 AppleScript)와 좌표를 맞춘다: 창 720×440pt, 아이콘 128pt, 앱 (160,200) · Applications (400,200) · 설치 안내 (610,200).
// 사용: swift make-background.swift <out.png>   (1440×880px, 144dpi로 저장해 Finder가 720×440pt로 보인다)
import AppKit

let out = URL(fileURLWithPath: CommandLine.arguments[1])
let scale: CGFloat = 2
let size = NSSize(width: 720 * scale, height: 440 * scale)
// 화면 배율에 끌려가지 않도록 고정 크기 비트맵에 직접 그린다(lockFocus는 실행 중인 화면의 배율을 따라간다).
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width), pixelsHigh: Int(size.height), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSGraphicsContext.current?.imageInterpolation = .high

// 바탕: 위가 조금 밝은 회백색. 라이트·다크 모드 어디서도 글자가 읽힌다.
let bg = NSGradient(colors: [NSColor(calibratedWhite: 0.97, alpha: 1), NSColor(calibratedWhite: 0.91, alpha: 1)])!
bg.draw(in: NSRect(origin: .zero, size: size), angle: -90)

// 좌표는 pt·왼쪽 위 원점으로 적고 여기서 픽셀·왼쪽 아래 원점으로 바꾼다.
func p(_ x: CGFloat, _ y: CGFloat) -> NSPoint { NSPoint(x: x * scale, y: size.height - y * scale) }
func text(_ s: String, at x: CGFloat, _ y: CGFloat, size pt: CGFloat, weight: NSFont.Weight = .regular, color: NSColor = NSColor(calibratedWhite: 0.15, alpha: 1), center: Bool = false) {
  let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: pt * scale, weight: weight), .foregroundColor: color]
  let str = NSAttributedString(string: s, attributes: attrs)
  let w = str.size().width
  let origin = p(center ? x - w / scale / 2 : x, y)
  str.draw(at: NSPoint(x: origin.x, y: origin.y - str.size().height))
}

text("Approve Here 설치", at: 24, 22, size: 20, weight: .bold)
text("터미널 없이, 끌어 넣고 여는 것이 전부입니다.", at: 24, 48, size: 12.5, color: NSColor(calibratedWhite: 0.4, alpha: 1))

// 끌어 넣기 화살표: 앱 아이콘(160)과 Applications(400) 사이.
let arrow = NSBezierPath()
arrow.lineWidth = 5 * scale
arrow.lineCapStyle = .round
arrow.move(to: p(238, 200))
arrow.line(to: p(322, 200))
arrow.move(to: p(306, 186)); arrow.line(to: p(322, 200)); arrow.line(to: p(306, 214))
NSColor(calibratedRed: 0.16, green: 0.36, blue: 0.92, alpha: 1).setStroke()
arrow.stroke()
text("① 끌어 넣기", at: 280, 172, size: 13, weight: .semibold, color: NSColor(calibratedRed: 0.16, green: 0.36, blue: 0.92, alpha: 1), center: true)

// 아래 안내. Finder 아이콘 이름표(아이콘 아래 ~290pt)와 겹치지 않게 320pt부터.
let dark = NSColor(calibratedWhite: 0.15, alpha: 1)
text("② Applications에서 Approve Here를 엽니다. 메뉴바에 받은편지함 아이콘이 생깁니다.", at: 24, 324, size: 13, color: dark)
text("③ \"Apple이 확인할 수 없습니다\"라고 막히면 완료를 누른 뒤,", at: 24, 350, size: 13, color: dark)
text("     시스템 설정 › 개인정보 보호 및 보안 › 맨 아래 \"그래도 열기\"를 누릅니다. 한 번만 합니다.", at: 24, 372, size: 13, color: dark)
text("막히는 이유와 화면 순서는 오른쪽 \"설치 안내\"를 두 번 눌러 보세요.", at: 24, 404, size: 12, color: NSColor(calibratedWhite: 0.42, alpha: 1))

NSGraphicsContext.restoreGraphicsState()
// 144dpi로 적어 Finder가 2x 이미지를 720×440pt로 놓게 한다.
rep.size = NSSize(width: 720, height: 440)
try! rep.representation(using: .png, properties: [:])!.write(to: out)
print("background: \(out.path)")
