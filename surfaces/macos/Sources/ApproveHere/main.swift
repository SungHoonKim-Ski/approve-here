import AppKit
import ServiceManagement
import UserNotifications

/// 메뉴바 앱이 제품의 전부다. 훅 등록(연결 켜기/끄기), 데몬 기동, 화면 오른쪽 위 카드 패널, 메뉴의 대기 목록을 처리한다.
/// 판단 로직은 없다 — 훅·데몬(번들된 Node 코어)의 계약을 소비할 뿐이다.
final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
  private let client = InboxClient()
  private var item: NSStatusItem!
  private var cards: CardPanelController!
  private var node: String?
  private var pending: [PendingRequest] = []
  private var known: Set<String> = []
  private var daemonUp = false
  private var notice: String?
  private var lastEnsureAt = Date.distantPast
  private var timer: Timer?
  private var notificationsGranted = false
  private let work = DispatchQueue(label: "approve-here.runtime")

  /// 이 번들이 /Applications 밖에 있고 /Applications에 사본이 있으면, 훅 경로를 이쪽으로 끌어오지 않는다(개발 빌드가 설치본을 덮지 않게).
  private var yieldsToInstalled: Bool {
    let installed = "/Applications/ApproveHere.app"
    return !Bundle.main.bundlePath.hasPrefix(installed) && FileManager.default.fileExists(atPath: installed)
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    // 같은 앱이 이미 떠 있으면 이 인스턴스는 물러난다. 둘이 돌면 훅 경로를 서로 덮는다.
    let others = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "").filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
    if !others.isEmpty {
      Runtime.log("another instance running (\(others.map(\.processIdentifier))) — quitting \(Bundle.main.bundlePath)")
      NSApp.terminate(nil)
      return
    }
    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    item.menu = NSMenu()
    cards = CardPanelController(actions: .init(
      allow: { [weak self] r in self?.decide(r.id, "allow", nil) },
      allowRemember: { [weak self] r in self?.decide(r.id, "allow", r.commandPrefix) },
      deny: { [weak self] r in self?.decide(r.id, "deny", nil) },
      answer: { [weak self] r, answers in self?.answer(r.id, answers) },
      passthrough: { [weak self] r in self?.passthrough(r.id) }
    ))
    if Bundle.main.bundleIdentifier != nil { setupNotifications() }
    Runtime.log("launch bundle=\(Bundle.main.bundlePath) core=\(Runtime.coreBundled)")
    render()
    bootstrap()
    timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.poll() }
  }

  func applicationWillTerminate(_ notification: Notification) {
    if let node { Runtime.stopDaemon(node: node) }
  }

  // MARK: 기동

  private func bootstrap() {
    work.async { [weak self] in
      guard let self else { return }
      let found = Runtime.findNode()
      Runtime.log("node=\(found ?? "없음") \(found.map(Runtime.nodeVersion) ?? "")")
      DispatchQueue.main.async { self.node = found; self.render() }
      guard let found else { return }
      if self.yieldsToInstalled {
        Runtime.log("running outside /Applications while installed copy exists — leaving hooks alone")
        DispatchQueue.main.async { self.notice = "Applications에 설치된 앱이 있어 이 사본은 훅을 건드리지 않습니다" }
      }
      // 앱을 옮겼거나 node가 바뀌었거나 이벤트가 늘었으면 등록된 훅을 조용히 맞춘다.
      for provider in Provider.allCases where !self.yieldsToInstalled && HookConnections.isStale(provider, node: found) {
        try? HookConnections.connect(provider, node: found)
        DispatchQueue.main.async {
          self.notice = "\(provider.title) 훅을 갱신했습니다" + (provider == .codex ? " — Codex가 다음 실행에서 훅 신뢰를 다시 물어요" : "")
        }
      }
      Runtime.ensureDaemon(node: found)
      DispatchQueue.main.async { self.poll() }
    }
  }

  private func poll() {
    Task { @MainActor in
      do {
        let next = try await client.pending()
        daemonUp = true
        let fresh = next.filter { !known.contains($0.id) }
        known.formUnion(next.map(\.id))
        pending = next
        cards.sync(next)
        for request in fresh {
          notify(request)
          // 질문은 답이 있어야 세션이 이어진다 — 소리로 부른다. 승인 요청은 잦아서 소리 없이 카드만.
          if request.isQuestion { NSSound(named: "Glass")?.play() }
        }
      } catch {
        daemonUp = false
        pending = []
        cards.sync([])
        ensureDaemonIfNeeded()
      }
      render()
    }
  }

  private func ensureDaemonIfNeeded() {
    guard let node, Date().timeIntervalSince(lastEnsureAt) > 15 else { return }
    lastEnsureAt = Date()
    work.async { Runtime.ensureDaemon(node: node) }
  }

  // MARK: 메뉴

  private func render() {
    let connected = Provider.allCases.filter(HookConnections.isConnected)
    // 글자 하나짜리 아이콘은 다른 상태 아이콘 사이에서 안 보인다. 받은편지함 모양으로 두고, 대기 수만 글자로 붙인다.
    let symbol = node == nil ? "exclamationmark.triangle" : !daemonUp ? "tray" : pending.isEmpty ? (connected.isEmpty ? "tray" : "tray.full") : "tray.and.arrow.down.fill"
    if let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "Approve Here") {
      image.isTemplate = true
      item.button?.image = image
      item.button?.imagePosition = pending.isEmpty ? .imageOnly : .imageLeading
    }
    item.button?.title = pending.isEmpty ? "" : " \(pending.count)"
    item.button?.toolTip = "Approve Here · \(pending.count)건 대기 · \(connected.map(\.title).joined(separator: ", "))"
    let menu = NSMenu()

    if node == nil {
      menu.addItem(disabled("Node.js를 찾을 수 없습니다"))
      menu.addItem(disabled("Claude Code·Codex가 쓰는 Node.js가 필요합니다"))
      menu.addItem(action("Node.js 내려받기…", #selector(openNodeDownload)))
      menu.addItem(action("다시 찾기", #selector(retryNode)))
    } else {
      for provider in Provider.allCases {
        let on = HookConnections.isConnected(provider)
        let entry = action("\(provider.title)  \(on ? "연결됨" : "연결 안 됨")", #selector(toggleConnection(_:)))
        entry.state = on ? .on : .off
        entry.representedObject = provider.rawValue
        menu.addItem(entry)
      }
      if connected.contains(.codex) { menu.addItem(disabled("   Codex는 다음 실행 때 훅 신뢰를 한 번 물어요")) }
    }
    menu.addItem(.separator())

    if !daemonUp {
      menu.addItem(disabled(node == nil ? "대기함 꺼짐" : "대기함 준비 중…"))
    } else if pending.isEmpty {
      menu.addItem(disabled(connected.isEmpty ? "위에서 연결을 켜면 승인 요청이 여기로 옵니다" : "대기 중인 요청 없음"))
    }
    for request in pending { menu.addItem(requestMenu(request)) }
    menu.addItem(.separator())

    if let notice { menu.addItem(disabled(notice)) }
    let login = action("로그인 시 시작", #selector(toggleLoginItem))
    login.state = SMAppService.mainApp.status == .enabled ? .on : .off
    menu.addItem(login)
    menu.addItem(action("기록 폴더 열기", #selector(openHome)))
    menu.addItem(withTitle: "종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    item.menu = menu
  }

  private func requestMenu(_ request: PendingRequest) -> NSMenuItem {
    let label = request.isQuestion ? "질문" : request.toolName
    let who = [request.provider == "codex" ? "Codex" : "Claude Code", request.project ?? "?", request.tmux?.title].compactMap { $0 }.joined(separator: " · ")
    let entry = NSMenuItem(title: "\(who) · \(label) · \(request.summary.prefix(40))", action: nil, keyEquivalent: "")
    let sub = NSMenu()
    if let working = request.workingOn { sub.addItem(disabled("지금: \(working.prefix(90))")); sub.addItem(.separator()) }
    if request.isQuestion {
      for q in request.questions ?? [] {
        sub.addItem(disabled(String(q.question.prefix(90))))
        if (request.questions?.count ?? 0) == 1, !(q.multiSelect ?? false) {
          for option in q.options ?? [] {
            let pick = action("   \(option.label)", #selector(answerOption(_:)))
            pick.representedObject = [request.id, q.question, option.label]
            if let d = option.description { pick.toolTip = d }
            sub.addItem(pick)
          }
        } else {
          sub.addItem(disabled("   → 카드에서 고르세요"))
        }
      }
      sub.addItem(.separator())
      sub.addItem(requestAction("카드 다시 열기", #selector(reopenCard(_:)), request))
    } else {
      if let description = request.description {
        sub.addItem(disabled(String(description.prefix(90))))
        sub.addItem(.separator())
      }
      sub.addItem(requestAction("허용", #selector(allow(_:)), request))
      if let prefix = request.commandPrefix { sub.addItem(requestAction("허용 + \"\(prefix)\" 앞으로 자동", #selector(allowRemember(_:)), request)) }
      sub.addItem(requestAction("거부", #selector(deny(_:)), request))
    }
    if request.tmux?.pane != nil { sub.addItem(requestAction("요청한 tmux 창으로 이동", #selector(jump(_:)), request)) }
    entry.submenu = sub
    return entry
  }

  private func disabled(_ title: String) -> NSMenuItem {
    let entry = NSMenuItem(title: title, action: nil, keyEquivalent: "")
    entry.isEnabled = false
    return entry
  }

  private func action(_ title: String, _ selector: Selector) -> NSMenuItem {
    let entry = NSMenuItem(title: title, action: selector, keyEquivalent: "")
    entry.target = self
    return entry
  }

  private func requestAction(_ title: String, _ selector: Selector, _ request: PendingRequest) -> NSMenuItem {
    let entry = action(title, selector)
    entry.representedObject = request.id
    return entry
  }

  // MARK: 연결

  @objc private func toggleConnection(_ sender: NSMenuItem) {
    guard let raw = sender.representedObject as? String, let provider = Provider(rawValue: raw), let node else { return }
    if yieldsToInstalled {
      notice = "Applications의 Approve Here에서 연결을 켜고 끄세요"
      render()
      return
    }
    do {
      if HookConnections.isConnected(provider) {
        try HookConnections.disconnect(provider)
        notice = "\(provider.title) 연결을 끊었습니다"
      } else {
        try HookConnections.connect(provider, node: node)
        notice = provider == .codex ? "Codex 연결됨 — 다음 codex 실행에서 'Hooks need review'가 뜨면 신뢰해 주세요" : "Claude Code 연결됨 — 승인·질문이 여기로 옵니다"
        ensureDaemonIfNeeded()
      }
    } catch {
      notice = "설정 파일을 쓰지 못했습니다: \(error.localizedDescription)"
      Runtime.log("connection error \(error)")
    }
    render()
  }

  @objc private func retryNode() { bootstrap() }
  @objc private func openNodeDownload() { NSWorkspace.shared.open(URL(string: "https://nodejs.org/")!) }
  @objc private func openHome() { NSWorkspace.shared.open(Runtime.home) }

  @objc private func toggleLoginItem() {
    do {
      if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() } else { try SMAppService.mainApp.register() }
    } catch {
      notice = "로그인 시 시작 설정 실패: \(error.localizedDescription)"
    }
    render()
  }

  // MARK: 결정

  @objc private func allow(_ sender: NSMenuItem) { decide(sender.representedObject as? String, "allow", nil) }
  @objc private func deny(_ sender: NSMenuItem) { decide(sender.representedObject as? String, "deny", nil) }
  @objc private func allowRemember(_ sender: NSMenuItem) {
    guard let id = sender.representedObject as? String, let request = pending.first(where: { $0.id == id }) else { return }
    decide(id, "allow", request.commandPrefix)
  }
  @objc private func jump(_ sender: NSMenuItem) {
    guard let id = sender.representedObject as? String else { return }
    Task { try? await client.jump(id) }
  }
  @objc private func answerOption(_ sender: NSMenuItem) {
    guard let parts = sender.representedObject as? [String], parts.count == 3 else { return }
    answer(parts[0], [parts[1]: parts[2]])
  }
  @objc private func reopenCard(_ sender: NSMenuItem) {
    guard let id = sender.representedObject as? String else { return }
    Task { @MainActor in
      cards.unhide(id)
      poll()
    }
  }

  private func decide(_ id: String?, _ behavior: String, _ remember: String?) {
    guard let id else { return }
    Task { @MainActor in
      try? await client.decide(id, behavior: behavior, remember: remember)
      poll()
    }
  }

  private func answer(_ id: String, _ answers: [String: String]) {
    Task { @MainActor in
      try? await client.answer(id, answers: answers)
      poll()
    }
  }

  private func passthrough(_ id: String?) {
    guard let id else { return }
    Task { @MainActor in
      try? await client.passthrough(id)
      poll()
    }
  }

  // MARK: 시스템 알림 — 허용된 경우에만 덤으로. 카드 패널이 주 경로다.

  private func setupNotifications() {
    let center = UNUserNotificationCenter.current()
    center.delegate = self
    let allow = UNNotificationAction(identifier: "allow", title: "허용", options: [])
    let deny = UNNotificationAction(identifier: "deny", title: "거부", options: [.destructive])
    center.setNotificationCategories([UNNotificationCategory(identifier: "request", actions: [allow, deny], intentIdentifiers: [])])
    center.requestAuthorization(options: [.alert, .sound]) { [weak self] granted, error in
      self?.notificationsGranted = granted
      Runtime.log("notification authorization granted=\(granted) \(error.map { "\($0)" } ?? "")")
    }
  }

  private func notify(_ request: PendingRequest) {
    guard notificationsGranted else { return }
    let content = UNMutableNotificationContent()
    content.title = "[\(request.provider)] \(request.project ?? "요청")"
    content.body = request.description ?? request.summary
    content.categoryIdentifier = request.isQuestion ? "" : "request"
    content.userInfo = ["id": request.id]
    content.sound = .default
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: request.id, content: content, trigger: nil))
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
    guard let id = response.notification.request.content.userInfo["id"] as? String else { return }
    switch response.actionIdentifier {
    case "allow": try? await client.decide(id, behavior: "allow")
    case "deny": try? await client.decide(id, behavior: "deny")
    default: break
    }
    await MainActor.run { poll() }
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
    [.banner, .sound]
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
