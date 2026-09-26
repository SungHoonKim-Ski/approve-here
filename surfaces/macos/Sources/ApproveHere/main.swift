import AppKit
import UserNotifications

/// 메뉴바 대기함. 어느 앱에 있든 뱃지로 대기 수를 보이고, 메뉴 또는 알림 버튼으로 결정하고, 그 tmux 창으로 점프한다.
/// 데몬 API만 소비한다. 알림 액션은 .app 번들로 실행될 때만 켠다(UNUserNotificationCenter는 번들 ID가 필요하다).
final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
  private let client = InboxClient()
  private var item: NSStatusItem!
  private var pending: [PendingRequest] = []
  private var known: Set<String> = []
  private var daemonUp = false
  private var timer: Timer?
  private let notificationsEnabled = Bundle.main.bundleIdentifier != nil

  func applicationDidFinishLaunching(_ notification: Notification) {
    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    item.menu = NSMenu()
    if notificationsEnabled { setupNotifications() }
    render()
    timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.poll() }
    poll()
  }

  private func poll() {
    Task { @MainActor in
      do {
        let next = try await client.pending()
        daemonUp = true
        let fresh = next.filter { !known.contains($0.id) }
        known.formUnion(next.map(\.id))
        pending = next
        for request in fresh { notify(request) }
      } catch {
        daemonUp = false
        pending = []
        ensureDaemon()
      }
      render()
    }
  }

  private var lastEnsureAt = Date.distantPast

  /// 표면이 데몬을 데리고 다닌다. 데몬이 없으면 CLI에 띄워 달라고 한다(로그인 셸로 PATH를 얻는다). 15초에 한 번만.
  private func ensureDaemon() {
    guard Date().timeIntervalSince(lastEnsureAt) > 15 else { return }
    lastEnsureAt = Date()
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/zsh")
    process.arguments = ["-lc", "command -v approve-here >/dev/null && approve-here ensure-daemon"]
    process.standardOutput = nil
    process.standardError = nil
    try? process.run()
  }

  // MARK: 메뉴

  private func render() {
    item.button?.title = daemonUp ? (pending.isEmpty ? "✓" : "⏳ \(pending.count)") : "⏸"
    item.button?.toolTip = daemonUp ? "approve-here · \(pending.count)건 대기" : "approve-here · 데몬 연결 안 됨"
    let menu = NSMenu()
    if !daemonUp {
      menu.addItem(withTitle: "데몬 연결 안 됨 — `approve-here start`", action: nil, keyEquivalent: "")
    } else if pending.isEmpty {
      menu.addItem(withTitle: "대기 중인 승인 요청 없음", action: nil, keyEquivalent: "")
    }
    for request in pending {
      let title = "[\(request.provider)] \(request.project ?? "?") · \(request.summary.prefix(60))"
      let entry = NSMenuItem(title: String(title), action: nil, keyEquivalent: "")
      let sub = NSMenu()
      if let description = request.description {
        let d = NSMenuItem(title: String(description.prefix(90)), action: nil, keyEquivalent: "")
        d.isEnabled = false
        sub.addItem(d)
        sub.addItem(.separator())
      }
      sub.addItem(action("허용", #selector(allow(_:)), request))
      if let prefix = request.commandPrefix {
        sub.addItem(action("허용 + \"\(prefix)\" 앞으로 자동", #selector(allowRemember(_:)), request))
      }
      sub.addItem(action("거부", #selector(deny(_:)), request))
      if request.tmux?.pane != nil { sub.addItem(action("그 tmux 창으로", #selector(jump(_:)), request)) }
      entry.submenu = sub
      menu.addItem(entry)
    }
    menu.addItem(.separator())
    menu.addItem(withTitle: "종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    item.menu = menu
  }

  private func action(_ title: String, _ selector: Selector, _ request: PendingRequest) -> NSMenuItem {
    let entry = NSMenuItem(title: title, action: selector, keyEquivalent: "")
    entry.target = self
    entry.representedObject = request.id
    return entry
  }

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

  private func decide(_ id: String?, _ behavior: String, _ remember: String?) {
    guard let id else { return }
    Task { @MainActor in
      try? await client.decide(id, behavior: behavior, remember: remember)
      poll()
    }
  }

  // MARK: 알림 (번들일 때만)

  private func setupNotifications() {
    let center = UNUserNotificationCenter.current()
    center.delegate = self
    let allow = UNNotificationAction(identifier: "allow", title: "허용", options: [])
    let deny = UNNotificationAction(identifier: "deny", title: "거부", options: [.destructive])
    let jump = UNNotificationAction(identifier: "jump", title: "창으로", options: [.foreground])
    center.setNotificationCategories([UNNotificationCategory(identifier: "request", actions: [allow, deny, jump], intentIdentifiers: [])])
    center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
  }

  private func notify(_ request: PendingRequest) {
    guard notificationsEnabled else { return }
    let content = UNMutableNotificationContent()
    content.title = "[\(request.provider)] \(request.project ?? "승인 요청")"
    content.body = request.description ?? request.summary
    content.categoryIdentifier = "request"
    content.userInfo = ["id": request.id]
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: request.id, content: content, trigger: nil))
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
    guard let id = response.notification.request.content.userInfo["id"] as? String else { return }
    switch response.actionIdentifier {
    case "allow": try? await client.decide(id, behavior: "allow")
    case "deny": try? await client.decide(id, behavior: "deny")
    case "jump": try? await client.jump(id)
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
