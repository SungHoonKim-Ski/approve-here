import Foundation

/// Claude Code·Codex 설정 파일에 훅을 넣고 빼는 일. CLI의 install.mjs와 같은 규칙이다:
/// 다른 설정과 다른 훅은 건드리지 않고, 우리 항목(permission-hook.mjs)은 이벤트마다 하나만 유지한다.
enum Provider: String, CaseIterable {
  case claude, codex

  var title: String { self == .claude ? "Claude Code" : "Codex" }

  var settingsURL: URL {
    let home = FileManager.default.homeDirectoryForCurrentUser
    return self == .claude
      ? home.appendingPathComponent(".claude/settings.json")
      : URL(fileURLWithPath: ProcessInfo.processInfo.environment["CODEX_HOME"] ?? home.appendingPathComponent(".codex").path).appendingPathComponent("hooks.json")
  }

  /// Claude 질문은 PreToolUse, Codex CLI 질문은 코어의 App Server 연결로 받는다. Codex 앱 중계는 실험적이다.
  /// PostToolUse는 "터미널에서 답했다"는 신호 — 양쪽에 떠 있던 카드를 지운다.
  var events: [(event: String, matcher: String?)] {
    self == .claude
      ? [("PermissionRequest", nil), ("PreToolUse", "AskUserQuestion"), ("PostToolUse", "AskUserQuestion")]
      : [("PermissionRequest", nil), ("PostToolUse", nil)]
  }
}

struct HookConnections {
  static let marker = "permission-hook.mjs"

  /// 훅 명령. node는 절대경로로 박는다 — GUI에서 띄운 CLI는 PATH가 비어 있을 수 있다.
  static func command(for provider: Provider, node: String) -> String {
    "\"\(node)\" \"\(Runtime.hookScript.path)\" --provider \(provider.rawValue)"
  }

  static func registeredCommand(_ provider: Provider, event: String = "PermissionRequest") -> String? {
    guard let root = read(provider.settingsURL) else { return nil }
    for group in groups(root, event) {
      for hook in group["hooks"] as? [[String: Any]] ?? [] {
        if let command = hook["command"] as? String, command.contains(marker) { return command }
      }
    }
    return nil
  }

  static func isConnected(_ provider: Provider) -> Bool { registeredCommand(provider) != nil }

  /// 등록된 명령이 지금의 앱 위치·node와 다르거나(앱을 옮겼거나 node를 갈았으면), 이벤트 하나가 빠져 있으면 다시 쓴다.
  static func isStale(_ provider: Provider, node: String) -> Bool {
    guard isConnected(provider) else { return false }
    let expected = command(for: provider, node: node)
    guard let root = read(provider.settingsURL) else { return true }
    return provider.events.contains { event, matcher in
      !groups(root, event).contains { group in
        (group["matcher"] as? String) == matcher && (group["hooks"] as? [[String: Any]] ?? []).contains { ($0["command"] as? String) == expected }
      }
    }
  }

  static func connect(_ provider: Provider, node: String, settingsURL: URL? = nil) throws {
    let url = settingsURL ?? provider.settingsURL
    var root = try readForEdit(url)
    var hooks = root["hooks"] as? [String: Any] ?? [:]
    for (event, matcher) in provider.events {
      var ours: [String: Any] = ["hooks": [["type": "command", "command": command(for: provider, node: node), "timeout": 600]]]
      if let matcher { ours["matcher"] = matcher }
      hooks[event] = withoutOurs(groups(root, event)) + [ours]
    }
    root["hooks"] = hooks
    try write(root, to: url)
    Runtime.log("connect \(provider.rawValue) → \(url.path)")
  }

  static func disconnect(_ provider: Provider, settingsURL: URL? = nil) throws {
    let url = settingsURL ?? provider.settingsURL
    guard FileManager.default.fileExists(atPath: url.path) else { return }
    var root = try readForEdit(url)
    var hooks = root["hooks"] as? [String: Any] ?? [:]
    for (event, _) in provider.events {
      let kept = withoutOurs(groups(root, event))
      if kept.isEmpty { hooks.removeValue(forKey: event) } else { hooks[event] = kept }
    }
    root["hooks"] = hooks
    try write(root, to: url)
    Runtime.log("disconnect \(provider.rawValue) → \(url.path)")
  }

  // MARK: - 내부

  private static func groups(_ root: [String: Any], _ event: String) -> [[String: Any]] {
    ((root["hooks"] as? [String: Any])?[event] as? [[String: Any]]) ?? []
  }

  private static func withoutOurs(_ groups: [[String: Any]]) -> [[String: Any]] {
    groups.compactMap { group in
      let hooks = (group["hooks"] as? [[String: Any]] ?? []).filter { !(($0["command"] as? String) ?? "").contains(marker) }
      if hooks.isEmpty { return nil }
      var copy = group
      copy["hooks"] = hooks
      return copy
    }
  }

  private static func read(_ url: URL) -> [String: Any]? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  }

  /// 읽지 못하는 설정을 빈 설정으로 취급하면 기존 CLI 설정을 덮어쓰게 된다.
  private static func readForEdit(_ url: URL) throws -> [String: Any] {
    guard FileManager.default.fileExists(atPath: url.path) else { return [:] }
    let data = try Data(contentsOf: url)
    guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
      throw ConnectionError.invalidSettings(url)
    }
    if let rawHooks = root["hooks"] {
      guard let hooks = rawHooks as? [String: Any] else { throw ConnectionError.invalidSettings(url) }
      for rawGroups in hooks.values {
        guard let groups = rawGroups as? [[String: Any]] else { throw ConnectionError.invalidSettings(url) }
        for group in groups {
          guard group["hooks"] is [[String: Any]] else { throw ConnectionError.invalidSettings(url) }
        }
      }
    }
    return root
  }

  private static func write(_ root: [String: Any], to url: URL) throws {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let data = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
    try (String(data: data, encoding: .utf8)! + "\n").write(to: url, atomically: true, encoding: .utf8)
  }
}

enum ConnectionError: LocalizedError {
  case invalidSettings(URL)

  var errorDescription: String? {
    switch self {
    case .invalidSettings(let url):
      return "\(url.lastPathComponent)의 내용을 읽을 수 없어 기존 설정을 보존했습니다. 설정 파일을 확인한 뒤 다시 연결해 주세요."
    }
  }
}
