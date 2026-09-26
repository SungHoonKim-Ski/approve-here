import AppKit
import ServiceManagement
import SwiftUI

/// 처음 켰을 때(또는 메뉴에서 부르면) 오른쪽 위에 뜨는 시작 안내. 이 앱을 처음 보는 사람이 여기서만 다 켤 수 있어야 한다.
@MainActor
final class OnboardingPanel {
  struct Actions {
    var connect: (Provider) -> Void
    var toggleLogin: () -> Void
    var demoCard: () -> Void
  }

  private var panel: NSPanel?
  private let actions: Actions
  private let width: CGFloat = 400

  init(actions: Actions) { self.actions = actions }

  static var seen: Bool {
    get { UserDefaults.standard.bool(forKey: "onboardingSeen") }
    set { UserDefaults.standard.set(newValue, forKey: "onboardingSeen") }
  }

  var isShowing: Bool { panel != nil }

  func show(node: String?) {
    close()
    let panel = KeyablePanel(contentRect: NSRect(x: 0, y: 0, width: width, height: 10),
                             styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.becomesKeyOnlyIfNeeded = true
    panel.level = .statusBar
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.isMovableByWindowBackground = true
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    let view = OnboardingView(node: node, actions: actions, close: { [weak self] in
      OnboardingPanel.seen = true
      self?.close()
    })
    let hosting = NSHostingView(rootView: view)
    hosting.frame = NSRect(x: 0, y: 0, width: width, height: 10)
    panel.contentView = hosting
    hosting.layoutSubtreeIfNeeded()
    let height = hosting.fittingSize.height
    panel.setContentSize(NSSize(width: width, height: height > 40 && height < 1500 ? height : 320))
    let mouse = NSEvent.mouseLocation
    if let screen = NSScreen.screens.first(where: { $0.frame.insetBy(dx: -1, dy: -1).contains(mouse) }) ?? NSScreen.screens.first {
      let frame = screen.visibleFrame
      panel.setFrameOrigin(NSPoint(x: frame.maxX - panel.frame.width - 12, y: frame.maxY - 12 - panel.frame.height))
    }
    panel.orderFrontRegardless()
    self.panel = panel
    Runtime.log("onboarding shown frame=\(panel.frame)")
  }

  /// 연결 상태가 바뀌면 안내 카드도 다시 그린다.
  func refresh(node: String?) {
    guard panel != nil else { return }
    show(node: node)
  }

  func close() {
    panel?.orderOut(nil)
    panel = nil
  }
}

struct OnboardingView: View {
  let node: String?
  let actions: OnboardingPanel.Actions
  let close: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Image(systemName: "tray.full").font(.title3)
        Text("Approve Here").font(.headline)
        Spacer()
        Button(action: close) { Image(systemName: "xmark").font(.caption) }.buttonStyle(.plain).foregroundStyle(.secondary)
      }
      Text("Claude Code·Codex가 \"허용할까요?\"라고 물을 때, 터미널을 찾지 않고 여기서 답합니다. 질문도 여기서 답합니다.")
        .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)

      if node == nil {
        VStack(alignment: .leading, spacing: 6) {
          Label("Node.js를 찾을 수 없습니다", systemImage: "exclamationmark.triangle").fontWeight(.medium)
          Text("Claude Code·Codex가 쓰는 Node.js가 필요합니다. 설치 뒤 메뉴바 아이콘 → \"다시 찾기\"를 누르세요.").font(.caption).foregroundStyle(.secondary)
          Button("Node.js 내려받기") { NSWorkspace.shared.open(URL(string: "https://nodejs.org/")!) }.controlSize(.small)
        }
      } else {
        step(1, "쓰는 CLI를 연결합니다") {
          HStack(spacing: 8) {
            ForEach(Provider.allCases, id: \.rawValue) { provider in
              let on = HookConnections.isConnected(provider)
              Button(on ? "\(provider.title) 연결됨 ✓" : "\(provider.title) 연결") { actions.connect(provider) }
                .tint(on ? .green : nil).disabled(on)
            }
          }
          .controlSize(.small)
          if HookConnections.isConnected(.codex) {
            Text("Codex는 다음에 codex를 실행할 때 \"Hooks need review\"가 뜨면 신뢰해 주세요.").font(.caption).foregroundStyle(.secondary)
          }
        }
        step(2, "로그인할 때 자동으로 켜지게") {
          let on = SMAppService.mainApp.status == .enabled
          Button(on ? "로그인 시 시작 켜짐 ✓" : "로그인 시 시작 켜기") { actions.toggleLogin() }.tint(on ? .green : nil).controlSize(.small)
        }
        step(3, "어떻게 뜨는지 미리 봅니다") {
          Button("카드 시험해 보기") { actions.demoCard() }.controlSize(.small)
        }
      }

      Divider()
      Text("승인은 CLI가 원래 물어볼 상황에서만 옵니다. Claude Code가 auto 모드이거나 허용 목록에 있는 명령은 원래대로 조용히 지나갑니다. 이 안내는 메뉴바 아이콘 → \"시작 안내\"로 다시 볼 수 있습니다.")
        .font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }
    .padding(14)
    .frame(width: 400, alignment: .leading)
    .fixedSize(horizontal: false, vertical: true)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).stroke(.quaternary))
  }

  private func step<Content: View>(_ number: Int, _ title: String, @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 6) {
        Text("\(number)").font(.caption).fontWeight(.bold).frame(width: 18, height: 18).background(.tint.opacity(0.15), in: Circle())
        Text(title).fontWeight(.medium)
      }
      content().padding(.leading, 24)
    }
  }
}
