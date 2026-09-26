import AppKit
import SwiftUI

/// 요청이 오면 마우스가 있는 화면 오른쪽 위에 카드 패널을 띄운다. 시스템 알림 권한이 없어도 동작하고, 포커스를 빼앗지 않으며,
/// 질문 카드에는 옵션 버튼과 입력칸을 그대로 놓는다. 결정되면 카드는 사라진다.
@MainActor
final class CardPanelController {
  struct Actions {
    var allow: (PendingRequest) -> Void
    var allowRemember: (PendingRequest) -> Void
    var deny: (PendingRequest) -> Void
    var answer: (PendingRequest, [String: String]) -> Void
    var passthrough: (PendingRequest) -> Void
  }

  private var panels: [String: NSPanel] = [:]
  private var hidden: Set<String> = []
  private let actions: Actions
  private let width: CGFloat = 400

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
    }
    layout(order: pending.map(\.id))
  }

  /// 메뉴에서 "카드 다시 열기"를 눌렀을 때.
  func unhide(_ id: String) {
    hidden.remove(id)
  }

  private func makePanel(for request: PendingRequest) -> NSPanel {
    let panel = KeyablePanel(contentRect: NSRect(x: 0, y: 0, width: width, height: 10),
                             styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    // 뜰 때는 포커스를 빼앗지 않고, 입력칸을 클릭했을 때만 키 윈도우가 된다.
    panel.becomesKeyOnlyIfNeeded = true
    // 전체화면 Space의 앱 위에도 떠야 한다. .floating은 전체화면 창 아래로 깔린다.
    panel.level = .statusBar
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.isMovableByWindowBackground = true
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.hidesOnDeactivate = false
    let view = RequestCardView(request: request, actions: actions, close: { [weak self] in
      guard let self else { return }
      // 질문 카드를 닫는 것은 "여기서 안 답하겠다" — 그 세션의 원래 다이얼로그로 넘긴다. 권한 카드는 숨기기만(메뉴에 남는다).
      if request.isQuestion { self.actions.passthrough(request) } else { self.hidden.insert(request.id) }
      self.panels[request.id]?.orderOut(nil)
      self.panels.removeValue(forKey: request.id)
    })
    let hosting = NSHostingView(rootView: view)
    hosting.frame = NSRect(x: 0, y: 0, width: width, height: 10)
    panel.contentView = hosting
    panel.setContentSize(fit(hosting))
    panel.isReleasedWhenClosed = false
    panel.orderFrontRegardless()
    Runtime.log("card shown \(request.id) kind=\(request.kind ?? "permission") size=\(panel.frame.size)")
    return panel
  }

  /// 폭을 고정한 뒤 SwiftUI가 원하는 높이를 잰다. 값이 이상하면(0·음수·터무니없이 큼) 최소 높이로 둔다.
  private func fit(_ hosting: NSView) -> NSSize {
    hosting.layoutSubtreeIfNeeded()
    let measured = hosting.fittingSize.height
    let height = measured > 40 && measured < 1500 ? measured : 140
    return NSSize(width: width, height: height)
  }

  private func layout(order: [String]) {
    // 사용자가 보고 있는 화면 = 마우스 커서가 있는 화면. accessory 앱은 NSScreen.main을 믿을 수 없다(키 윈도우가 없다).
    let mouse = NSEvent.mouseLocation
    guard let screen = NSScreen.screens.first(where: { $0.frame.insetBy(dx: -1, dy: -1).contains(mouse) }) ?? NSScreen.screens.first else { return }
    let frame = screen.visibleFrame
    var top = frame.maxY - 12
    for id in order {
      guard let panel = panels[id] else { continue }
      // 옵션을 고르거나 입력하면 카드 내용이 바뀌므로 매번 크기를 다시 맞춘다.
      if let hosting = panel.contentView { panel.setContentSize(fit(hosting)) }
      let size = panel.frame.size
      panel.setFrameOrigin(NSPoint(x: frame.maxX - size.width - 12, y: top - size.height))
      top -= size.height + 10
    }
    if !order.isEmpty { Runtime.log("card layout screen=\(frame) frames=\(order.compactMap { panels[$0]?.frame })") }
  }
}

/// 테두리 없는 창은 기본으로 키 윈도우가 못 되어 텍스트 입력을 받지 못한다. 카드 안 입력칸이 타이핑을 받으려면 이걸 열어야 한다.
final class KeyablePanel: NSPanel {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }
}

struct RequestCardView: View {
  let request: PendingRequest
  let actions: CardPanelController.Actions
  let close: () -> Void
  @State private var draft: [String: String] = [:]
  @State private var typed: [String: String] = [:]

  private var questions: [PendingRequest.Question] { request.questions ?? [] }
  private var complete: Bool { !questions.isEmpty && questions.allSatisfy { draft[$0.question] != nil } }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      header
      if let working = request.workingOn {
        Text(working).font(.caption).foregroundStyle(.secondary).lineLimit(2)
      }
      if request.isQuestion { questionBody } else { permissionBody }
    }
    .padding(12)
    .frame(width: 400, alignment: .leading)
    .fixedSize(horizontal: false, vertical: true)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).stroke(.quaternary))
  }

  /// 어느 세션인지: [claude] 프로젝트 · 창 이름. 창 이름이 없으면 도구 이름.
  private var header: some View {
    HStack(spacing: 6) {
      Text(request.provider == "codex" ? "Codex" : "Claude Code").fontWeight(.semibold)
      Text("·").foregroundStyle(.secondary)
      Text(request.project ?? "?")
      if let title = request.tmux?.title, !title.isEmpty {
        Text("·").foregroundStyle(.secondary)
        Text(title).foregroundStyle(.secondary).lineLimit(1)
      }
      Spacer()
      Text(request.isQuestion ? "질문" : "승인 요청").foregroundStyle(.secondary)
      Button(action: close) { Image(systemName: "xmark").font(.caption) }
        .buttonStyle(.plain).foregroundStyle(.secondary)
        .help(request.isQuestion ? "여기서 답하지 않고 그 세션의 다이얼로그로 넘깁니다" : "카드를 숨깁니다(메뉴에는 남습니다)")
    }
    .font(.caption)
  }

  private var permissionBody: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(request.summary).font(.system(.callout, design: .monospaced)).lineLimit(4).textSelection(.enabled)
      if let description = request.description { Text("↳ \(description)").font(.caption).foregroundStyle(.secondary).lineLimit(3) }
      HStack(spacing: 8) {
        Button("허용") { actions.allow(request) }.tint(.green)
        if let prefix = request.commandPrefix { Button("허용 + \(prefix) 자동") { actions.allowRemember(request) } }
        Button("거부") { actions.deny(request) }.tint(.red)
      }
      .controlSize(.small)
    }
  }

  private var questionBody: some View {
    VStack(alignment: .leading, spacing: 10) {
      // 왜 묻는지 — 질문 직전 agent의 설명.
      if let background = request.context?.assistant, !background.isEmpty {
        Text(background).font(.caption).foregroundStyle(.secondary).lineLimit(5)
          .padding(8).frame(maxWidth: .infinity, alignment: .leading)
          .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
      }
      ForEach(questions, id: \.question) { q in
        VStack(alignment: .leading, spacing: 6) {
          HStack(spacing: 6) {
            if let header = q.header, !header.isEmpty {
              Text(header).font(.caption2).padding(.horizontal, 6).padding(.vertical, 2)
                .background(.tint.opacity(0.15), in: Capsule())
            }
            Text(q.question).font(.callout).fontWeight(.medium)
          }
          if let options = q.options, !options.isEmpty {
            if options.contains(where: { !($0.description ?? "").isEmpty }) {
              // 설명이 있는 옵션은 설명이 곧 배경이라 세로 목록으로 다 보인다.
              ForEach(options, id: \.label) { option in
                Button { pick(q, option.label) } label: {
                  HStack(alignment: .top, spacing: 8) {
                    Image(systemName: selected(q).contains(option.label) ? "checkmark.circle.fill" : "circle").padding(.top, 2)
                    VStack(alignment: .leading, spacing: 2) {
                      Text(option.label).fontWeight(.medium)
                      if let d = option.description, !d.isEmpty { Text(d).font(.caption).foregroundStyle(.secondary) }
                    }
                    Spacer(minLength: 0)
                  }
                  .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain)
                .padding(6)
                .background(selected(q).contains(option.label) ? Color.accentColor.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 6))
              }
            } else {
              FlowButtons(items: options.map(\.label), selected: selected(q)) { label in pick(q, label) }
            }
          }
          // 옵션에 없는 답. Claude의 "Other"에 해당한다.
          TextField(q.options?.isEmpty == false ? "다른 답 직접 입력…" : "답 입력…", text: typedBinding(q))
            .textFieldStyle(.roundedBorder)
            .controlSize(.small)
            .onSubmit { submitTyped(q) }
        }
      }
      HStack(spacing: 8) {
        Button("답 보내기") { send() }.tint(.green).disabled(!readyToSend)
        Spacer()
        Text(questions.count > 1 ? "\(draft.count)/\(questions.count) 답함" : "").font(.caption).foregroundStyle(.secondary)
      }
      .controlSize(.small)
    }
  }

  private var readyToSend: Bool {
    // 다 골랐거나, 아직 안 고른 질문마다 입력칸에 글이 있으면 보낼 수 있다.
    questions.allSatisfy { draft[$0.question] != nil || !(typed[$0.question] ?? "").trimmingCharacters(in: .whitespaces).isEmpty }
  }

  private func typedBinding(_ q: PendingRequest.Question) -> Binding<String> {
    Binding(get: { typed[q.question] ?? "" }, set: { typed[q.question] = $0 })
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
    if questions.count == 1 { actions.answer(request, draft) }
  }

  private func submitTyped(_ q: PendingRequest.Question) {
    let text = (typed[q.question] ?? "").trimmingCharacters(in: .whitespaces)
    guard !text.isEmpty else { return }
    draft[q.question] = text
    if questions.count == 1 { actions.answer(request, draft) }
  }

  private func send() {
    var answers = draft
    for q in questions where answers[q.question] == nil {
      let text = (typed[q.question] ?? "").trimmingCharacters(in: .whitespaces)
      if !text.isEmpty { answers[q.question] = text }
    }
    guard answers.count == questions.count else { return }
    actions.answer(request, answers)
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
      if width + w > 370, !rows[rows.count - 1].isEmpty { rows.append([]); width = 0 }
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
