import AppKit
import SwiftUI

/// 요청이 오면 화면 오른쪽 위에 카드 패널을 띄운다. 시스템 알림 권한이 없어도 동작하고, 포커스를 빼앗지 않으며,
/// 질문 카드에는 옵션 버튼을 그대로 놓을 수 있다. 결정되면 카드는 사라진다.
@MainActor
final class CardPanelController {
  struct Actions {
    var allow: (PendingRequest) -> Void
    var allowRemember: (PendingRequest) -> Void
    var deny: (PendingRequest) -> Void
    var jump: (PendingRequest) -> Void
    var answer: (PendingRequest, [String: String]) -> Void
    var passthrough: (PendingRequest) -> Void
  }

  private var panels: [String: NSPanel] = [:]
  private var hidden: Set<String> = []
  private let actions: Actions
  private let width: CGFloat = 380

  init(actions: Actions) { self.actions = actions }

  func sync(_ pending: [PendingRequest]) {
    let ids = Set(pending.map(\.id))
    for (id, panel) in panels where !ids.contains(id) {
      panel.orderOut(nil)
      panels.removeValue(forKey: id)
    }
    hidden = hidden.intersection(ids)
    for request in pending where panels[request.id] == nil && !hidden.contains(request.id) {
      panels[request.id] = makePanel(for: request)
      Runtime.log("card shown \(request.id) visible=\(panels[request.id]!.isVisible) frame=\(panels[request.id]!.frame)")
    }
    layout(order: pending.map(\.id))
  }

  private func makePanel(for request: PendingRequest) -> NSPanel {
    let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: width, height: 10),
                        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    // 전체화면 Space의 앱 위에도 떠야 한다. .floating은 전체화면 창 아래로 깔린다.
    panel.level = .statusBar
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.isMovableByWindowBackground = true
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.hidesOnDeactivate = false
    let view = RequestCardView(request: request, actions: actions, hide: { [weak self] in
      guard let self else { return }
      self.hidden.insert(request.id)
      self.panels[request.id]?.orderOut(nil)
      self.panels.removeValue(forKey: request.id)
    })
    let hosting = NSHostingView(rootView: view)
    panel.contentView = hosting
    let height = max(hosting.fittingSize.height, 96)
    panel.setContentSize(NSSize(width: width, height: height))
    panel.isReleasedWhenClosed = false
    panel.orderFrontRegardless()
    return panel
  }

  private func layout(order: [String]) {
    // 사용자가 보고 있는 화면 = 마우스 커서가 있는 화면. accessory 앱은 NSScreen.main을 믿을 수 없다(키 윈도우가 없다).
    let mouse = NSEvent.mouseLocation
    // 커서가 화면 가장자리에 정확히 걸치면 contains가 빠뜨린다. 1pt 넉넉히 본다.
    guard let screen = NSScreen.screens.first(where: { $0.frame.insetBy(dx: -1, dy: -1).contains(mouse) }) ?? NSScreen.screens.first else {
      Runtime.log("card layout: screen 없음")
      return
    }
    let frame = screen.visibleFrame
    var top = frame.maxY - 12
    for id in order {
      guard let panel = panels[id] else { continue }
      let size = panel.frame.size
      panel.setFrameOrigin(NSPoint(x: frame.maxX - size.width - 12, y: top - size.height))
      top -= size.height + 10
    }
    if !order.isEmpty {
      Runtime.log("card layout screens=\(NSScreen.screens.count) visible=\(frame) frames=\(order.compactMap { panels[$0]?.frame })")
    }
  }
}

struct RequestCardView: View {
  let request: PendingRequest
  let actions: CardPanelController.Actions
  let hide: () -> Void
  @State private var draft: [String: String] = [:]

  private var complete: Bool { (request.questions ?? []).allSatisfy { draft[$0.question] != nil } }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 6) {
        Text("[\(request.provider)]").fontWeight(.semibold)
        Text(request.project ?? "?")
        Text("·").foregroundStyle(.secondary)
        Text(request.isQuestion ? "질문" : request.toolName).foregroundStyle(.secondary)
        if let pane = request.tmux?.pane { Text("· tmux \(pane)").foregroundStyle(.secondary) }
        Spacer()
        Button(action: hide) { Image(systemName: "xmark").font(.caption) }.buttonStyle(.plain).foregroundStyle(.secondary)
      }
      .font(.caption)

      if request.isQuestion {
        questionBody
      } else {
        permissionBody
      }
    }
    .padding(12)
    .frame(width: 380, alignment: .leading)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).stroke(.quaternary))
  }

  private var permissionBody: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(request.summary).font(.system(.callout, design: .monospaced)).lineLimit(4).textSelection(.enabled)
      if let description = request.description { Text("↳ \(description)").font(.caption).foregroundStyle(.secondary).lineLimit(3) }
      HStack(spacing: 8) {
        Button("허용") { actions.allow(request) }.tint(.green)
        if let prefix = request.commandPrefix {
          Button("허용 + \(prefix) 자동") { actions.allowRemember(request) }
        }
        Button("거부") { actions.deny(request) }.tint(.red)
        if request.tmux?.pane != nil { Button("창으로") { actions.jump(request) } }
      }
      .controlSize(.small)
    }
  }

  private var questionBody: some View {
    VStack(alignment: .leading, spacing: 10) {
      ForEach(request.questions ?? [], id: \.question) { q in
        VStack(alignment: .leading, spacing: 6) {
          Text(q.question).font(.callout).fontWeight(.medium)
          if let options = q.options, !options.isEmpty {
            FlowButtons(items: options.map(\.label), selected: selected(q)) { label in pick(q, label) }
            if let chosen = draft[q.question], let option = options.first(where: { $0.label == chosen }), let detail = option.description {
              Text(detail).font(.caption).foregroundStyle(.secondary)
            }
          } else {
            Text("옵션이 없는 질문입니다 — 터미널에서 답하세요").font(.caption).foregroundStyle(.secondary)
          }
        }
      }
      HStack(spacing: 8) {
        if (request.questions?.count ?? 0) > 1 || (request.questions?.first?.multiSelect ?? false) {
          Button("답 보내기") { actions.answer(request, draft) }.disabled(!complete).tint(.green)
        }
        Button("터미널에서 답하기") { actions.passthrough(request) }
        if request.tmux?.pane != nil { Button("창으로") { actions.jump(request) } }
      }
      .controlSize(.small)
    }
  }

  private func selected(_ q: PendingRequest.Question) -> Set<String> {
    guard let value = draft[q.question] else { return [] }
    return Set(value.split(separator: ", ").map(String.init))
  }

  /// 단일 선택·질문 하나면 누르는 순간 보낸다. 여러 질문이나 multiSelect는 다 고른 뒤 "답 보내기".
  private func pick(_ q: PendingRequest.Question, _ label: String) {
    if q.multiSelect ?? false {
      var set = selected(q)
      if set.contains(label) { set.remove(label) } else { set.insert(label) }
      draft[q.question] = set.isEmpty ? nil : (q.options ?? []).map(\.label).filter(set.contains).joined(separator: ", ")
      return
    }
    draft[q.question] = label
    if (request.questions?.count ?? 0) == 1 { actions.answer(request, draft) }
  }
}

/// 옵션 버튼을 줄바꿈으로 흘려 놓는다.
struct FlowButtons: View {
  let items: [String]
  let selected: Set<String>
  let tap: (String) -> Void

  var body: some View {
    var rows: [[String]] = [[]]
    var width: CGFloat = 0
    for item in items {
      let w = CGFloat(item.count) * 9 + 28
      if width + w > 350, !rows[rows.count - 1].isEmpty { rows.append([]); width = 0 }
      rows[rows.count - 1].append(item)
      width += w + 6
    }
    return VStack(alignment: .leading, spacing: 6) {
      ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
        HStack(spacing: 6) {
          ForEach(row, id: \.self) { label in
            Button(label) { tap(label) }
              .buttonStyle(.bordered)
              .tint(selected.contains(label) ? .accentColor : nil)
              .controlSize(.small)
          }
        }
      }
    }
  }
}
