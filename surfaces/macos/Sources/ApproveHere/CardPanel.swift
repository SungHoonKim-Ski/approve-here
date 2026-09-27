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
  private var feedbacks: [String: CardFeedback] = [:]
  private var hidden: Set<String> = []
  private let actions: Actions
  private let width: CGFloat = 400
  /// 화면을 다 덮지 않도록 이 수까지만 펼친다. 나머지는 "N건 더" 한 줄로 접힌다.
  private let maxVisible = 2
  private var expanded = false
  private var summary: NSPanel?

  init(actions: Actions) { self.actions = actions }

  func sync(_ pending: [PendingRequest]) {
    let ids = Set(pending.map(\.id) + ["demo"])
    feedbacks = feedbacks.filter { ids.contains($0.key) }
    for (id, panel) in panels where !ids.contains(id) {
      panel.orderOut(nil)
      panels.removeValue(forKey: id)
    }
    hidden = hidden.intersection(ids)
    // 한 세션은 카드 한 장만 차지한다. 같은 세션의 나머지는 이 카드가 처리된 뒤 차례로 뜬다.
    var seenSessions = Set<String>()
    let perSession = pending.filter { request in
      guard let session = request.sessionId else { return true }
      return seenSessions.insert(session).inserted
    }
    queuedBySession = Dictionary(grouping: pending.filter { $0.sessionId != nil }, by: { $0.sessionId! }).mapValues { $0.count - 1 }
    if perSession.count <= maxVisible { expanded = false }
    let visible = expanded ? perSession : Array(perSession.prefix(maxVisible))
    // 접힌 카드는 패널을 내린다(메뉴에는 남는다).
    for request in pending where !visible.contains(where: { $0.id == request.id }) {
      panels[request.id]?.orderOut(nil)
      panels.removeValue(forKey: request.id)
    }
    for request in visible where !hidden.contains(request.id) {
      let queued = request.sessionId.flatMap { queuedBySession[$0] } ?? 0
      // 같은 세션에 뒤따르는 요청 수가 바뀌면 머리의 "이 세션에 N건 더"가 낡으므로 카드를 다시 그린다.
      if panels[request.id] != nil && panelQueued[request.id] == queued { continue }
      panels[request.id]?.orderOut(nil)
      panels[request.id] = makePanel(for: request)
      panelQueued[request.id] = queued
    }
    updateSummary(total: perSession.count)
    layout(order: (panels["demo"] != nil ? ["demo"] : []) + visible.map(\.id))
  }

  /// 세션별로 이 카드 뒤에 기다리는 요청 수. 카드 머리에 "이 세션에 N건 더"로 보인다.
  private(set) var queuedBySession: [String: Int] = [:]
  /// 각 카드가 그려질 때의 대기 수 — 바뀌면 다시 그린다.
  private var panelQueued: [String: Int] = [:]

  /// "N건 더 · 펼치기" / "접기" 한 줄. 카드가 maxVisible을 넘을 때만 보인다.
  private func updateSummary(total: Int) {
    guard total > maxVisible else {
      summary?.orderOut(nil)
      summary = nil
      return
    }
    let hiddenCount = total - maxVisible
    let view = QueueSummaryView(total: total, hiddenCount: hiddenCount, expanded: expanded) { [weak self] in
      guard let self else { return }
      self.expanded.toggle()
      Runtime.log("queue \(self.expanded ? "expanded" : "collapsed") total=\(total)")
      NotificationCenter.default.post(name: .approveHereResync, object: nil)
    }
    if summary == nil {
      let panel = KeyablePanel(contentRect: NSRect(x: 0, y: 0, width: width, height: 10), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
      panel.level = .statusBar
      panel.isOpaque = false
      panel.backgroundColor = .clear
      panel.hasShadow = true
      panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
      panel.hidesOnDeactivate = false
      panel.isReleasedWhenClosed = false
      summary = panel
    }
    let hosting = NSHostingView(rootView: view)
    hosting.frame = NSRect(x: 0, y: 0, width: width, height: 10)
    summary?.contentView = hosting
    summary?.setContentSize(fit(hosting))
    summary?.orderFrontRegardless()
  }

  /// 메뉴에서 "카드 다시 열기"를 눌렀을 때.
  func unhide(_ id: String) {
    hidden.remove(id)
  }

  /// 메뉴와 카드에서 연달아 누르더라도 같은 답변을 두 번 보내지 않는다.
  func beginSubmission(_ id: String) -> Bool {
    let feedback = feedbacks[id] ?? CardFeedback()
    guard !feedback.isSending else { return false }
    feedbacks[id] = feedback
    feedback.message = nil
    feedback.isSending = true
    return true
  }

  func finishSubmission(_ id: String, error: String? = nil) {
    feedbacks[id]?.isSending = false
    feedbacks[id]?.message = error
  }

  /// 시작 안내의 "카드 시험해 보기". 데몬을 거치지 않는 가짜 카드 — 버튼을 누르면 사라지기만 한다.
  func showDemo() {
    let sample = """
    {"id":"demo","kind":"permission","provider":"claude","project":"my-app","toolName":"Bash",
     "toolInput":{"command":"npm test -- --watch=false","description":"변경한 결제 모듈의 테스트를 돌릴까요?"},
     "description":"변경한 결제 모듈의 테스트를 돌릴까요?","createdAt":"\(ISO8601DateFormatter().string(from: Date()))",
     "tmux":{"pane":null,"title":"결제-환불"},
     "context":{"task":"환불 API를 추가하고 테스트를 통과시켜 줘","latest":"환불 API를 추가하고 테스트를 통과시켜 줘","assistant":null}}
    """
    guard let data = sample.data(using: .utf8), let request = try? JSONDecoder().decode(PendingRequest.self, from: data) else { return }
    let dismiss: (PendingRequest) -> Void = { [weak self] _ in
      self?.panels["demo"]?.orderOut(nil)
      self?.panels.removeValue(forKey: "demo")
    }
    let demoActions = Actions(allow: dismiss, allowRemember: dismiss, deny: dismiss, answer: { r, _ in dismiss(r) }, passthrough: dismiss)
    panels["demo"]?.orderOut(nil)
    panels["demo"] = makePanel(for: request, actions: demoActions)
    layout(order: ["demo"] + panels.keys.filter { $0 != "demo" })
  }

  private func makePanel(for request: PendingRequest, actions override: Actions? = nil) -> NSPanel {
    let actions = override ?? self.actions
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
    let queued = request.sessionId.flatMap { queuedBySession[$0] } ?? 0
    let feedback = feedbacks[request.id] ?? CardFeedback()
    feedbacks[request.id] = feedback
    let view = RequestCardView(request: request, queuedInSession: queued, feedback: feedback, actions: actions, close: { [weak self] in
      guard let self else { return }
      // 질문 카드를 닫는 것은 "여기서 안 답하겠다" — 그 세션의 원래 다이얼로그로 넘긴다. 권한 카드는 숨기기만(메뉴에 남는다).
      if request.isQuestion { actions.passthrough(request) } else if request.id != "demo" { self.hidden.insert(request.id) }
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
    // 요약 줄은 40pt가 안 된다. 20pt 아래나 터무니없이 큰 값만 잘못 잰 것으로 본다.
    let height = measured > 20 && measured < 1500 ? measured : 140
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
    if let summary {
      let size = summary.frame.size
      summary.setFrameOrigin(NSPoint(x: frame.maxX - size.width - 12, y: top - size.height))
    }
    if !order.isEmpty { Runtime.log("card layout screen=\(frame) frames=\(order.compactMap { panels[$0]?.frame } + (summary.map { [$0.frame] } ?? []))") }
  }
}

/// 테두리 없는 창은 기본으로 키 윈도우가 못 되어 텍스트 입력을 받지 못한다. 카드 안 입력칸이 타이핑을 받으려면 이걸 열어야 한다.
final class KeyablePanel: NSPanel {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }
}

final class CardFeedback: ObservableObject {
  @Published var isSending = false
  @Published var message: String?
}

struct RequestCardView: View {
  let request: PendingRequest
  var queuedInSession: Int = 0
  @ObservedObject var feedback: CardFeedback
  let actions: CardPanelController.Actions
  let close: () -> Void
  @State private var draft: [String: String] = [:]
  @State private var typed: [String: String] = [:]
  /// 질문이 여럿이면 하나씩 보인다. 지금 보고 있는 질문 번호.
  @State private var index = 0

  private var questions: [PendingRequest.Question] { request.questions ?? [] }
  private var complete: Bool { !questions.isEmpty && questions.allSatisfy { draft[$0.answerKey] != nil } }
  private var current: PendingRequest.Question? { questions.indices.contains(index) ? questions[index] : nil }
  private var isLast: Bool { index >= questions.count - 1 }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      header
      if let working = request.workingOn {
        Text(working).font(.caption).foregroundStyle(.secondary).lineLimit(2)
      }
      if request.isQuestion { questionBody } else { permissionBody }
      if feedback.isSending {
        HStack(spacing: 6) {
          ProgressView().controlSize(.small)
          Text("답변을 보내는 중…").font(.caption)
        }
      } else if let message = feedback.message {
        Label(message, systemImage: "exclamationmark.circle")
          .font(.caption).foregroundStyle(.red)
          .fixedSize(horizontal: false, vertical: true)
      }
      handoffLine
    }
    .disabled(feedback.isSending)
    .padding(12)
    .frame(width: 400, alignment: .leading)
    .fixedSize(horizontal: false, vertical: true)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).stroke(.quaternary))
  }

  /// 터미널과의 관계를 한 줄로. mirror면 양쪽에 떠 있고, wait+handoffAt이면 그 시각에 터미널로 넘어간다.
  @ViewBuilder private var handoffLine: some View {
    if request.isCodexDirect {
      Text("Codex 앱·CLI에서도 답할 수 있습니다").font(.caption2).foregroundStyle(.secondary)
    } else if request.isMirror {
      Text("터미널에도 떠 있습니다 · 어느 쪽에서 답해도 됩니다").font(.caption2).foregroundStyle(.secondary)
    } else if let handoff = request.handoffDate {
      TimelineView(.periodic(from: .now, by: 1)) { context in
        let remaining = Int(handoff.timeIntervalSince(context.date).rounded(.up))
        Text(remaining > 0 ? "\(remaining)초 안에 답하지 않으면 원래 화면으로 넘어갑니다" : "원래 화면으로 넘어갔습니다")
          .font(.caption2).foregroundStyle(.secondary)
      }
    }
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
      if queuedInSession > 0 { Text("이 세션에 \(queuedInSession)건 더").foregroundStyle(.secondary) }
      Text(request.isQuestion ? (questions.count > 1 ? "질문 \(index + 1)/\(questions.count)" : "질문") : "승인 요청").foregroundStyle(.secondary)
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
      if let q = current {
        VStack(alignment: .leading, spacing: 6) {
          HStack(spacing: 6) {
            if let header = q.header, !header.isEmpty {
              Text(header).font(.caption2).padding(.horizontal, 6).padding(.vertical, 2)
                .background(.tint.opacity(0.15), in: Capsule())
            }
            Text(q.question).font(.callout).fontWeight(.medium)
            if q.multiSelect ?? false { Text("여러 개 선택").font(.caption2).foregroundStyle(.secondary) }
          }
          if let options = q.options, !options.isEmpty {
            if options.contains(where: { !($0.description ?? "").isEmpty }) {
              // 설명이 있는 옵션은 설명이 곧 배경이라 세로 목록으로 다 보인다.
              ForEach(options, id: \.label) { option in
                Button { pick(q, option.label) } label: {
                  HStack(alignment: .top, spacing: 8) {
                    Image(systemName: icon(q, chosen: selected(q).contains(option.label))).padding(.top, 2)
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
        if index > 0 { Button("이전") { index -= 1 } }
        if isLast {
          Button("답 보내기") { send() }.tint(.green).disabled(!readyToSend).keyboardShortcut(.defaultAction)
        } else {
          Button("다음") { advance() }.disabled(!currentAnswered).keyboardShortcut(.defaultAction)
        }
        Spacer()
        Text(currentAnswered || readyToSend ? "" : "옵션을 고르거나 직접 입력하세요").font(.caption).foregroundStyle(.secondary)
      }
      .controlSize(.small)
    }
  }

  /// 지금 질문에 답이 있나(고른 옵션 또는 입력칸 글).
  private var currentAnswered: Bool {
    guard let q = current else { return false }
    return draft[q.answerKey] != nil || !(typed[q.answerKey] ?? "").trimmingCharacters(in: .whitespaces).isEmpty
  }

  /// 입력칸 글을 답으로 확정하고 다음 질문으로.
  private func advance() {
    if let q = current, draft[q.answerKey] == nil {
      let text = (typed[q.answerKey] ?? "").trimmingCharacters(in: .whitespaces)
      if !text.isEmpty { draft[q.answerKey] = text }
    }
    if !isLast { index += 1 }
  }

  private var readyToSend: Bool {
    // 다 골랐거나, 아직 안 고른 질문마다 입력칸에 글이 있으면 보낼 수 있다.
    questions.allSatisfy { draft[$0.answerKey] != nil || !(typed[$0.answerKey] ?? "").trimmingCharacters(in: .whitespaces).isEmpty }
  }

  private func typedBinding(_ q: PendingRequest.Question) -> Binding<String> {
    Binding(get: { typed[q.answerKey] ?? "" }, set: { typed[q.answerKey] = $0 })
  }

  private func selected(_ q: PendingRequest.Question) -> Set<String> {
    guard let value = draft[q.answerKey] else { return [] }
    return Set(value.split(separator: ", ").map(String.init))
  }

  /// 질문이 하나인 단일 선택은 터미널 다이얼로그처럼 고르는 순간 보낸다 — 두 번째 클릭을 기다리면 카드가 안 닫히는 것으로 보인다(실측).
  /// 여러 개 선택·직접 입력·질문이 여럿인 카드는 "답 보내기"(또는 Enter)로 보낸다 — 잘못 누른 것을 바로잡을 틈을 둔다.
  /// multiSelect는 토글이고, 답은 옵션 순서대로 ", "로 이어 보낸다(Claude가 다중 선택으로 받는 형식, 실측).
  private func pick(_ q: PendingRequest.Question, _ label: String) {
    if q.multiSelect ?? false {
      var set = selected(q)
      if set.contains(label) { set.remove(label) } else { set.insert(label) }
      draft[q.answerKey] = set.isEmpty ? nil : (q.options ?? []).map(\.label).filter(set.contains).joined(separator: ", ")
      return
    }
    draft[q.answerKey] = draft[q.answerKey] == label ? nil : label
    guard draft[q.answerKey] != nil else { return }
    // 고른 표시가 잠깐 보이도록 한 박자 뒤에 움직인다.
    if questions.count == 1 {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { send() }
    } else if !isLast {
      // 질문이 여럿이면 다음 질문으로 넘어간다(마지막 질문은 답 보내기를 기다린다).
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { index += 1 }
    }
  }

  private func icon(_ q: PendingRequest.Question, chosen: Bool) -> String {
    (q.multiSelect ?? false) ? (chosen ? "checkmark.square.fill" : "square") : (chosen ? "largecircle.fill.circle" : "circle")
  }

  private var answeredCount: Int {
    questions.filter { draft[$0.answerKey] != nil || !(typed[$0.answerKey] ?? "").trimmingCharacters(in: .whitespaces).isEmpty }.count
  }

  /// 입력칸에서 Enter: 마지막 질문이면 보내고, 아니면 다음 질문으로.
  private func submitTyped(_ q: PendingRequest.Question) {
    if isLast { if readyToSend { send() } } else { advance() }
  }

  private func send() {
    var answers = draft
    for q in questions where answers[q.answerKey] == nil {
      let text = (typed[q.answerKey] ?? "").trimmingCharacters(in: .whitespaces)
      if !text.isEmpty { answers[q.answerKey] = text }
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


extension Notification.Name {
  /// 요약 패널의 펼치기/접기 뒤 카드 배치를 다시 하라는 신호.
  static let approveHereResync = Notification.Name("approveHereResync")
}

/// 카드가 maxVisible을 넘을 때 그 아래 붙는 한 줄.
struct QueueSummaryView: View {
  let total: Int
  let hiddenCount: Int
  let expanded: Bool
  let toggle: () -> Void

  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: "tray.full")
      Text(expanded ? "요청 \(total)건 모두 펼침" : "요청 \(total)건 · \(hiddenCount)건 더 있음").font(.callout)
      Spacer()
      Button(expanded ? "접기" : "펼치기") { toggle() }.controlSize(.small)
    }
    .padding(.horizontal, 12).padding(.vertical, 8)
    .frame(width: 400, alignment: .leading)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).stroke(.quaternary))
  }
}
