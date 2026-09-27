import AppKit
import SwiftUI

/// JSON 원문을 유지해 목록을 연 뒤 다른 곳에서 변경한 규칙을 잘못 지우지 않는다.
struct AutomaticApprovalRule: Identifiable {
  let id = UUID()
  let value: Any

  var command: String { (value as? [String: Any])?["commandPrefix"] as? String ?? "알 수 없는 규칙" }
  var scope: String {
    let fields = value as? [String: Any] ?? [:]
    let provider = fields["provider"] as? String
    let agent = provider == "claude" ? "Claude Code" : provider == "codex" ? "Codex" : provider ?? "모든 에이전트"
    return "\(agent) · \(fields["tool"] as? String ?? "알 수 없는 도구")"
  }
}

@MainActor
final class RulesState: ObservableObject {
  @Published var rules: [AutomaticApprovalRule] = []
  @Published var loading = false
  @Published var hasLoaded = false
  @Published var removing: UUID?
  @Published var message: String?
}

@MainActor
final class RulesPanelController {
  private let client: InboxClient
  private let state = RulesState()
  private var window: NSWindow?

  init(client: InboxClient) { self.client = client }

  func show() {
    if window == nil {
      let view = RulesView(state: state, refresh: { [weak self] in self?.refresh() }, remove: { [weak self] rule in self?.remove(rule) })
      let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 420),
                            styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
      window.title = "자동 승인 관리"
      window.contentView = NSHostingView(rootView: view)
      window.minSize = NSSize(width: 420, height: 300)
      window.isReleasedWhenClosed = false
      window.center()
      self.window = window
    }
    NSApp.activate(ignoringOtherApps: true)
    window?.makeKeyAndOrderFront(nil)
    refresh()
  }

  private func refresh() {
    guard !state.loading, state.removing == nil else { return }
    state.loading = true
    state.message = nil
    Task {
      defer { state.loading = false }
      do {
        state.rules = try await client.automaticRules()
        state.hasLoaded = true
      }
      catch {
        state.message = describe(error, fallback: "목록을 가져오지 못했습니다. Approve Here가 실행 중인지 확인하고 다시 시도해 주세요.")
      }
    }
  }

  private func remove(_ rule: AutomaticApprovalRule) {
    guard !state.loading, state.removing == nil else { return }
    state.removing = rule.id
    state.message = nil
    Task {
      defer { state.removing = nil }
      do {
        state.rules = try await client.removeAutomaticRule(rule)
        state.hasLoaded = true
        state.message = "자동 승인을 해제했습니다. 다음 요청부터 적용됩니다."
      } catch {
        state.message = describe(error, fallback: "자동 승인 해제 여부를 확인하지 못했습니다. 목록을 새로고침해 확인한 뒤 다시 시도해 주세요.")
      }
    }
  }

  private func describe(_ error: Error, fallback: String) -> String {
    guard let error = error as? InboxError else { return fallback }
    switch error {
    case .daemonUnavailable:
      return "대기함에 연결할 수 없습니다. Approve Here를 다시 열고 새로고침해 주세요."
    case .http(409, _):
      return "이미 해제됐거나 변경된 규칙입니다. 새로고침해 현재 목록을 확인해 주세요."
    default:
      return error.errorDescription ?? fallback
    }
  }
}

struct RulesView: View {
  @ObservedObject var state: RulesState
  let refresh: () -> Void
  let remove: (AutomaticApprovalRule) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Text("자동 승인 관리").font(.headline)
        Spacer()
        Button("새로고침", action: refresh).disabled(state.loading || state.removing != nil)
      }
      Text("카드에서 ‘앞으로 자동’으로 기억시킨 명령입니다. 해제하면 이 앱은 다음 요청을 자동으로 허용하지 않습니다. 에이전트 자체의 허용 설정은 별도로 적용됩니다.")
        .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      if state.loading {
        Spacer()
        HStack { Spacer(); ProgressView("목록을 불러오는 중…"); Spacer() }
        Spacer()
      } else if state.rules.isEmpty {
        Spacer()
        HStack {
          Spacer()
          Label(state.hasLoaded ? "기억시킨 자동 승인 규칙이 없습니다" : "새로고침으로 목록을 불러와 주세요", systemImage: state.hasLoaded ? "checkmark.circle" : "arrow.clockwise")
            .foregroundStyle(.secondary)
          Spacer()
        }
        Spacer()
      } else {
        ScrollView {
          VStack(alignment: .leading, spacing: 10) {
            ForEach(state.rules) { rule in
              HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                  Text(rule.command).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                  Text(rule.scope).font(.caption).foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity, alignment: .leading)
                Button(state.removing == rule.id ? "해제 중…" : "자동 승인 해제") { remove(rule) }
                  .disabled(state.removing != nil)
              }
              Divider()
            }
          }.padding(.vertical, 4)
        }
      }
      if let message = state.message {
        Text(message).font(.caption).fixedSize(horizontal: false, vertical: true)
      }
    }.padding(16).frame(minWidth: 380, minHeight: 240)
      .background(Color(nsColor: .windowBackgroundColor))
  }
}
