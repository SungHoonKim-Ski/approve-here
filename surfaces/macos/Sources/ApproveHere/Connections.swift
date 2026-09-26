import Foundation

/// Claude Code·Codex 설정 파일에 PermissionRequest 훅을 넣고 빼는 일. CLI의 install.mjs와 같은 규칙이다:
/// 다른 설정과 다른 훅은 건드리지 않고, 우리 항목(permission-hook.mjs)은 하나만 유지한다.
enum Provider: String, CaseIterable {
  case claude, codex

  var title: String { self == .claude ? "Claude Code" : "Codex" }

  var settingsURL: URL {
    let home = FileManager.default.homeDirectoryForCurrentUser
    return self == .claude
      ? home.appendingPathComponent(".claude/settings.json")
      : home.appendingPathComponent(".codex/hooks.json")
  }
}

struct HookConnections {
  static let marker = "permission-hook.mjs"

  /// 훅 명령. node는 절대경로로 박는다 — GUI에서 띄운 CLI는 PATH가 비어 있을 수 있다.
  static func command(for provider: Provider, node: String) -> String {
    "\"\(node)\" \"\(Runtime.hookScript.path)\" --provider \(provider.rawValue)"
  }

  static func registeredCommand(_ provider: Provider) -> String? {
    guard let root = read(provider.settingsURL) else { return nil }
    for group in permissionRequestGroups(root) {
      for hook in group["hooks"] as? [[String: Any]] ?? [] {
        if let command = hook["command"] as? String, command.contains(marker) { return command }
      }
    }
    return nil
  }

  static func isConnected(_ provider: Provider) -> Bool { registeredCommand(provider) != nil }

  /// 등록된 명령이 지금의 앱 위치·node와 다르면(앱을 옮겼거나 node를 갈았으면) 다시 쓴다.
  static func isStale(_ provider: Provider, node: String) -> Bool {
    guard let registered = registeredCommand(provider) else { return false }
    return registered != command(for: provider, node: node)
  }

  static func connect(_ provider: Provider, node: String) throws {
    var root = read(provider.settingsURL) ?? [:]
    var hooks = root["hooks"] as? [String: Any] ?? [:]
    let kept = withoutOurs(permissionRequestGroups(root))
    let ours: [String: Any] = ["hooks": [["type": "command", "command": command(for: provider, node: node), "timeout": 600]]]
    hooks["PermissionRequest"] = kept + [ours]
    root["hooks"] = hooks
    try write(root, to: provider.settingsURL)
    Runtime.log("connect \(provider.rawValue) → \(provider.settingsURL.path)")
  }

  static func disconnect(_ provider: Provider) throws {
    guard var root = read(provider.settingsURL) else { return }
    var hooks = root["hooks"] as? [String: Any] ?? [:]
    let kept = withoutOurs(permissionRequestGroups(root))
    if kept.isEmpty { hooks.removeValue(forKey: "PermissionRequest") } else { hooks["PermissionRequest"] = kept }
    root["hooks"] = hooks
    try write(root, to: provider.settingsURL)
    Runtime.log("disconnect \(provider.rawValue)")
  }

  // MARK: - 내부

  private static func permissionRequestGroups(_ root: [String: Any]) -> [[String: Any]] {
    ((root["hooks"] as? [String: Any])?["PermissionRequest"] as? [[String: Any]]) ?? []
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

  private static func write(_ root: [String: Any], to url: URL) throws {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let data = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
    try (String(data: data, encoding: .utf8)! + "\n").write(to: url, atomically: true, encoding: .utf8)
  }
}
