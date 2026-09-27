import AppKit
import ServiceManagement
import UserNotifications

/// 메뉴바 앱이 제품의 전부다. 훅 등록(연결 켜기/끄기), 데몬 기동, 화면 오른쪽 위 카드 패널, 메뉴의 대기 목록을 처리한다.
/// 판단 로직은 없다 — 훅·데몬(번들된 Node 코어)의 계약을 소비할 뿐이다.
final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
  private let client = InboxClient()
  private var item: NSStatusItem!
  private var cards: CardPanelController!
  private var onboarding: OnboardingPanel!
  private var rulesPanel: RulesPanelController!
  private var node: String?
  private var pending: [PendingRequest] = []
  private var known: Set<String> = []
  private var daemonUp = false
  private var codexStatus: CodexConnectionStatus?
  private var notice: String?
  private var installingLauncher = false
  private var isBootstrapping = false
  private var startingDaemon = false
  private var startupError: String?
  private var lastEnsureAt = Date.distantPast
  private var timer: Timer?
  private var hotkey: GlobalHotkey?
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
    // 노치 노트북처럼 메뉴바가 좁으면 macOS가 우리 아이콘을 숨길 수 있다. 그때도 메뉴는 단축키로 부른다.
    hotkey = GlobalHotkey { [weak self] in self?.showMenuFromHotkey() }
    cards = CardPanelController(actions: .init(
      allow: { [weak self] r in self?.decide(r.id, "allow", nil) },
      allowRemember: { [weak self] r in self?.decide(r.id, "allow", r.commandPrefix) },
      deny: { [weak self] r in self?.decide(r.id, "deny", nil) },
      answer: { [weak self] r, answers in self?.answer(r.id, answers) },
      passthrough: { [weak self] r in self?.passthrough(r.id) }
    ))
    onboarding = OnboardingPanel(actions: .init(
      connect: { [weak self] provider in self?.connect(provider) },
      toggleLogin: { [weak self] in self?.toggleLoginItem() },
      demoCard: { [weak self] in self?.cards.showDemo() },
      retryNode: { [weak self] in self?.retryNode() },
      installCodexLauncher: { [weak self] in self?.installCodexLauncher() },
      revealCodexLauncher: { NSWorkspace.shared.activateFileViewerSelecting([Runtime.codexLauncher]) },
      openLogs: { _ = NSWorkspace.shared.open(Runtime.home) }
    ))
    rulesPanel = RulesPanelController(client: client)
    if Bundle.main.bundleIdentifier != nil { setupNotifications() }
    Runtime.log("launch bundle=\(Bundle.main.bundlePath) core=\(Runtime.coreBundled)")
    render()
    bootstrap()
    timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.poll() }
    NotificationCenter.default.addObserver(forName: .approveHereResync, object: nil, queue: .main) { [weak self] _ in self?.poll() }
  }

  func applicationWillTerminate(_ notification: Notification) {
    if let node { Runtime.stopDaemon(node: node) }
  }

  // MARK: 기동

  private func bootstrap() {
    guard !isBootstrapping, !startingDaemon else { return }
    isBootstrapping = true
    Task { @MainActor in self.onboarding.updateStartup(error: self.startupError, checking: true, node: self.node) }
    work.async { [weak self] in
      guard let self else { return }
      let found = Runtime.findNode()
      Runtime.log("node=\(found ?? "없음") \(found.map(Runtime.nodeVersion) ?? "")")
      DispatchQueue.main.async { self.node = found; self.render() }
      guard let found else {
        DispatchQueue.main.async {
          self.isBootstrapping = false
          self.startupError = nil
          self.onboarding.updateStartup(error: nil, checking: false, node: nil)
          self.onboarding.show(node: nil)
          self.render()
        }
        return
      }
      if self.yieldsToInstalled {
        Runtime.log("running outside /Applications while installed copy exists — leaving hooks alone")
        DispatchQueue.main.async { self.notice = "Applications에 설치된 앱이 있어 이 사본은 훅을 건드리지 않습니다" }
      }
      // 앱을 옮겼거나 node가 바뀌었거나 이벤트가 늘었으면 등록된 훅을 조용히 맞춘다.
      for provider in Provider.allCases where !self.yieldsToInstalled && HookConnections.isStale(provider, node: found) {
        do {
          try HookConnections.connect(provider, node: found)
          DispatchQueue.main.async {
            self.notice = "\(provider.title) 훅을 갱신했습니다" + (provider == .codex ? " — Codex가 다음 실행에서 훅 신뢰를 다시 물어요" : "")
          }
        } catch {
          Runtime.log("hook refresh failed: \(error)")
          DispatchQueue.main.async {
            self.notice = "\(provider.title) 연결을 갱신하지 못했습니다: \(error.localizedDescription)"
            self.onboarding.update(message: self.notice, node: self.node)
            self.onboarding.show(node: self.node)
          }
        }
      }
      let result = Runtime.ensureDaemon(node: found)
      DispatchQueue.main.async {
        self.isBootstrapping = false
        self.lastEnsureAt = Date()
        self.handleDaemonStart(result)
        self.poll()
        // 처음 켰거나 아무 CLI도 연결하지 않았으면 시작 안내를 띄운다.
        if result.status != 0 || !OnboardingPanel.seen || Provider.allCases.allSatisfy({ !HookConnections.isConnected($0) }) {
          self.onboarding.show(node: found)
        }
      }
    }
  }

  private func poll() {
    Task { @MainActor in
      do {
        let next = try await client.pending()
        daemonUp = true
        if startupError != nil {
          startupError = nil
          onboarding.updateStartup(error: nil, checking: isBootstrapping || startingDaemon, node: node)
        }
        codexStatus = try? await client.codexStatus()
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
        codexStatus = nil
        pending = []
        cards.sync([])
        if node != nil && !isBootstrapping && !startingDaemon && startupError == nil {
          startupError = "대기함에 연결할 수 없습니다. 연결을 다시 확인하거나 원래 에이전트 화면에서 답해 주세요."
          onboarding.updateStartup(error: startupError, checking: false, node: node)
        }
        ensureDaemonIfNeeded()
      }
      render()
    }
  }

  private func ensureDaemonIfNeeded() {
    guard let node, !isBootstrapping, !startingDaemon, Date().timeIntervalSince(lastEnsureAt) > 15 else { return }
    lastEnsureAt = Date()
    startingDaemon = true
    Task { @MainActor in self.onboarding.updateStartup(error: self.startupError, checking: true, node: self.node) }
    work.async { [weak self] in
      let result = Runtime.ensureDaemon(node: node)
      DispatchQueue.main.async {
        guard let self else { return }
        self.startingDaemon = false
        self.lastEnsureAt = Date()
        self.handleDaemonStart(result)
      }
    }
  }

  @MainActor private func handleDaemonStart(_ result: (status: Int32, output: String)) {
    if result.status != 0 {
      let detail = result.output.trimmingCharacters(in: .whitespacesAndNewlines)
      if detail.contains("EADDRINUSE") {
        startupError = "대기함의 연결 포트를 다른 프로그램이 사용하고 있습니다. 기록 폴더의 daemon.log를 확인해 주세요."
      } else if result.status == -2 {
        startupError = "대기함 시작에 시간이 너무 오래 걸렸습니다. 잠시 뒤 다시 시도해 주세요."
      } else {
        startupError = "대기함을 시작하지 못했습니다." + (detail.isEmpty ? "" : "\n\(detail.prefix(300))")
      }
    }
    onboarding.updateStartup(error: startupError, checking: false, node: node)
    render()
  }

  // MARK: 메뉴

  private func render() {
    let connected = Provider.allCases.filter(HookConnections.isConnected)
    // 글자 하나짜리 아이콘은 다른 상태 아이콘 사이에서 안 보인다. 받은편지함 모양으로 두고, 대기 수만 글자로 붙인다.
    let symbol = node == nil || startupError != nil ? "exclamationmark.triangle" : !daemonUp ? "tray" : pending.isEmpty ? (connected.isEmpty ? "tray" : "tray.full") : "tray.and.arrow.down.fill"
    if let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "Approve Here") {
      image.isTemplate = true
      item.button?.image = image
      item.button?.imagePosition = pending.isEmpty ? .imageOnly : .imageLeading
    }
    item.button?.title = pending.isEmpty ? "" : " \(pending.count)"
    item.button?.toolTip = "Approve Here · \(pending.count)건 대기 · \(connected.map(\.title).joined(separator: ", "))"
    let menu = NSMenu()

    if node == nil {
      if isBootstrapping {
        menu.addItem(disabled("Node.js를 확인하는 중…"))
      } else {
        menu.addItem(disabled("Node.js 20 이상을 찾을 수 없습니다"))
        menu.addItem(disabled("카드를 전달하는 데 Node.js가 필요합니다"))
        menu.addItem(action("Node.js 내려받기…", #selector(openNodeDownload)))
        menu.addItem(action("다시 찾기", #selector(retryNode)))
      }
    } else {
      for provider in Provider.allCases {
        let on = HookConnections.isConnected(provider)
        let entry = action("\(provider.title)  \(on ? "연결됨" : "연결 안 됨")", #selector(toggleConnection(_:)))
        entry.state = on ? .on : .off
        entry.isEnabled = !isBootstrapping
        entry.representedObject = provider.rawValue
        menu.addItem(entry)
      }
      if connected.contains(.codex) {
        let state = disabled(codexStatus?.sharedConnected == true ? "   Codex CLI 질문 연결됨" : "   Codex CLI 질문 연결 대기")
        state.toolTip = codexStatus?.sharedError ?? codexStatus?.error
        menu.addItem(state)
        let appConnections = codexStatus?.relayCount ?? 0
        menu.addItem(disabled(appConnections > 0 ? "   Codex 앱 연결됨 (\(appConnections)개)" : "   Codex 앱은 실행기로 열어 연결하세요"))
        menu.addItem(action("Codex 앱 중계 실행기 설치…", #selector(installCodexLauncher)))
      }
    }
    menu.addItem(.separator())

    if !daemonUp {
      menu.addItem(disabled(node == nil ? "대기함 꺼짐" : startupError == nil ? "대기함 준비 중…" : "대기함 연결 실패"))
      if startupError != nil { menu.addItem(action("연결 다시 확인", #selector(retryNode))) }
    } else if pending.isEmpty {
      menu.addItem(disabled(connected.isEmpty ? "위에서 연결을 켜면 승인 요청이 여기로 옵니다" : "대기 중인 요청 없음"))
    }
    for request in pending { menu.addItem(requestMenu(request)) }
    menu.addItem(.separator())

    if let notice { menu.addItem(disabled(notice)) }
    menu.addItem(action("시작 안내", #selector(showOnboarding)))
    menu.addItem(action("자동 승인 관리…", #selector(showAutomaticRules)))
    menu.addItem(action("카드 시험해 보기", #selector(showDemoCard)))
    menu.addItem(action("도움말 (README)", #selector(openHelp)))
    menu.addItem(disabled("아이콘이 숨겨져도 \(GlobalHotkey.label)로 이 메뉴가 뜹니다"))
    menu.addItem(.separator())
    let login = action("로그인 시 시작", #selector(toggleLoginItem))
    login.state = SMAppService.mainApp.status == .enabled ? .on : .off
    menu.addItem(login)
    menu.addItem(action("기록 폴더 열기", #selector(openHome)))
    menu.addItem(withTitle: "종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    item.menu = menu
  }

  /// 메뉴바 아이콘이 숨겨져 있어도 같은 메뉴를 마우스가 있는 화면 오른쪽 위에 띄운다(전역 단축키에서 부른다).
  private func showMenuFromHotkey() {
    render()
    guard let menu = item.menu else { return }
    let mouse = NSEvent.mouseLocation
    let screen = NSScreen.screens.first(where: { $0.frame.insetBy(dx: -1, dy: -1).contains(mouse) }) ?? NSScreen.screens.first
    guard let frame = screen?.visibleFrame else { return }
    Runtime.log("hotkey menu at screen=\(frame)")
    NSApp.activate(ignoringOtherApps: true)
    menu.popUp(positioning: nil, at: NSPoint(x: frame.maxX - 340, y: frame.maxY - 4), in: nil)
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
            pick.representedObject = [request.id, q.answerKey, option.label]
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
    guard let raw = sender.representedObject as? String, let provider = Provider(rawValue: raw) else { return }
    if HookConnections.isConnected(provider) { disconnect(provider) } else { connect(provider) }
  }

  private func connect(_ provider: Provider) {
    guard let node, !isBootstrapping else { return }
    if yieldsToInstalled {
      notice = "Applications의 Approve Here에서 연결을 켜고 끄세요"
      render()
      return
    }
    do {
      try HookConnections.connect(provider, node: node)
      notice = provider == .codex ? "Codex 훅 등록됨 — Codex를 다시 시작하고 훅을 검토·신뢰해 주세요" : "Claude Code 훅 등록됨 — 새 세션부터 승인·질문이 여기로 옵니다"
      ensureDaemonIfNeeded()
    } catch {
      notice = "설정 파일을 쓰지 못했습니다: \(error.localizedDescription)"
      Runtime.log("connection error \(error)")
    }
    render()
    Task { @MainActor in self.onboarding.update(message: self.notice, installingLauncher: self.installingLauncher, node: self.node) }
  }

  private func disconnect(_ provider: Provider) {
    guard !isBootstrapping else { return }
    if yieldsToInstalled {
      notice = "Applications의 Approve Here에서 연결을 켜고 끄세요"
      render()
      return
    }
    do {
      try HookConnections.disconnect(provider)
      notice = "\(provider.title) 연결을 끊었습니다"
    } catch {
      notice = "설정 파일을 쓰지 못했습니다: \(error.localizedDescription)"
    }
    render()
    Task { @MainActor in self.onboarding.update(message: self.notice, installingLauncher: self.installingLauncher, node: self.node) }
  }

  @objc private func retryNode() { bootstrap() }
  @objc private func openNodeDownload() { NSWorkspace.shared.open(URL(string: "https://nodejs.org/")!) }

  @objc private func installCodexLauncher() {
    guard let node, !installingLauncher else { return }
    installingLauncher = true
    notice = "Codex 실행기를 설치하고 있습니다…"
    Task { @MainActor in self.onboarding.update(message: self.notice, installingLauncher: true, node: self.node) }
    work.async { [weak self] in
      let (code, output) = Runtime.run(node, [Runtime.cliScript.path, "install-codex-launcher", "--prebuilt"], env: ["APPROVE_HERE_HOME": Runtime.home.path], timeout: 120)
      DispatchQueue.main.async {
        guard let self else { return }
        self.installingLauncher = false
        self.notice = code == 0 ? "실행기 설치 완료. Codex를 완전히 종료한 뒤 ‘설치된 실행기 보기’를 눌러 실행하세요." : "실행기를 설치하지 못했습니다: \(output.trimmingCharacters(in: .whitespacesAndNewlines))"
        self.render()
        self.onboarding.update(message: self.notice, node: self.node)
      }
    }
  }
  @objc private func openHome() { NSWorkspace.shared.open(Runtime.home) }

  @objc private func toggleLoginItem() {
    do {
      if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() } else { try SMAppService.mainApp.register() }
    } catch {
      notice = "로그인 시 시작 설정 실패: \(error.localizedDescription)"
    }
    render()
    Task { @MainActor in self.onboarding.update(message: self.notice, installingLauncher: self.installingLauncher, node: self.node) }
  }

  @objc private func showOnboarding() { Task { @MainActor in self.onboarding.show(node: self.node) } }
  @objc private func showAutomaticRules() { Task { @MainActor in self.rulesPanel.show() } }
  @objc private func showDemoCard() { Task { @MainActor in self.cards.showDemo() } }
  @objc private func openHelp() { NSWorkspace.shared.open(URL(string: "https://github.com/SungHoonKim-Ski/approve-here#readme")!) }

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
    submit(id) { [self] in
      try await client.decide(id, behavior: behavior, remember: remember)
    }
  }

  private func answer(_ id: String, _ answers: [String: String]) {
    submit(id) { [self] in
      try await client.answer(id, answers: answers)
    }
  }

  private func passthrough(_ id: String?) {
    guard let id else { return }
    submit(id) { [self] in
      try await client.passthrough(id)
    }
  }

  private func submit(_ id: String, operation: @escaping () async throws -> Void) {
    Task { @MainActor in
      guard cards.beginSubmission(id) else { return }
      do {
        try await operation()
        cards.finishSubmission(id)
        notice = "답변을 전달했습니다"
      } catch {
        let message = (error as? InboxError)?.errorDescription
          ?? "답변이 전달됐는지 확인하지 못했습니다. 원래 화면에서 요청 상태를 확인해 주세요."
        cards.finishSubmission(id, error: message)
        notice = message
        Runtime.log("answer failed id=\(id): \(error)")
        render()
      }
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
    await MainActor.run {
      switch response.actionIdentifier {
      case "allow": decide(id, "allow", nil)
      case "deny": decide(id, "deny", nil)
      default: poll()
      }
    }
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
