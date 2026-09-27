import Foundation

@main
struct ConnectionsSmoke {
  static func main() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("approve-here-settings-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let settings = root.appendingPathComponent("settings.json")

    for invalid in ["{broken", "[]", "null", "{\"hooks\":[]}", "{\"hooks\":{\"PermissionRequest\":{}}}", "{\"hooks\":{\"PermissionRequest\":[{\"hooks\":\"broken\"}]}}"] {
      try invalid.write(to: settings, atomically: true, encoding: .utf8)
      do {
        try HookConnections.connect(.claude, node: "/test/node", settingsURL: settings)
        fatalError("invalid settings were accepted")
      } catch ConnectionError.invalidSettings { }
      let afterConnect = try String(contentsOf: settings, encoding: .utf8)
      precondition(afterConnect == invalid)
      do {
        try HookConnections.disconnect(.claude, settingsURL: settings)
        fatalError("invalid settings were overwritten during disconnect")
      } catch ConnectionError.invalidSettings { }
      let afterDisconnect = try String(contentsOf: settings, encoding: .utf8)
      precondition(afterDisconnect == invalid)
    }

    let original = """
    {"permissions":{"allow":["Bash(git status)"]},"hooks":{"PermissionRequest":[{"hooks":[{"type":"command","command":"other-handler"}]}]}}
    """
    try original.write(to: settings, atomically: true, encoding: .utf8)
    try HookConnections.connect(.claude, node: "/test/node", settingsURL: settings)
    try HookConnections.connect(.claude, node: "/test/node", settingsURL: settings)
    let connected = try JSONSerialization.jsonObject(with: Data(contentsOf: settings)) as! [String: Any]
    let hooks = connected["hooks"] as! [String: Any]
    precondition((hooks["PermissionRequest"] as! [[String: Any]]).count == 2)
    precondition((connected["permissions"] as! [String: Any])["allow"] as! [String] == ["Bash(git status)"])
    try HookConnections.disconnect(.claude, settingsURL: settings)
    let disconnected = try JSONSerialization.jsonObject(with: Data(contentsOf: settings)) as! [String: Any]
    let kept = (disconnected["hooks"] as! [String: Any])["PermissionRequest"] as! [[String: Any]]
    precondition(kept.count == 1)
    precondition((kept[0]["hooks"] as! [[String: String]])[0]["command"] == "other-handler")
    print("PASS: malformed settings preserved; other hooks preserved; reconnect idempotent")
  }
}
