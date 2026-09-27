import Foundation

/// 앱이 품고 다니는 Node 코어(훅·데몬)와 그것을 돌릴 node를 찾는다. 사용자는 터미널을 열지 않는다.
enum Runtime {
  static let home: URL = {
    if let env = ProcessInfo.processInfo.environment["APPROVE_HERE_HOME"] { return URL(fileURLWithPath: env) }
    return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".approve-here")
  }()

  /// 번들 안의 코어. build.sh가 저장소의 bin/·core/·hook/·surfaces/를 Resources/core/로 복사한다.
  static let coreDir: URL = Bundle.main.resourceURL!.appendingPathComponent("core")
  static var hookScript: URL { coreDir.appendingPathComponent("hook/permission-hook.mjs") }
  static var cliScript: URL { coreDir.appendingPathComponent("bin/approve-here.mjs") }
  static var coreBundled: Bool { FileManager.default.fileExists(atPath: hookScript.path) }
  static var codexLauncher: URL {
    FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications/Codex with Approve Here.app")
  }

  private static let logURL = home.appendingPathComponent("app.log")

  static func log(_ message: String) {
    try? FileManager.default.createDirectory(at: home, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let line = "\(ISO8601DateFormatter().string(from: Date())) \(message)\n"
    if let handle = try? FileHandle(forWritingTo: logURL) {
      handle.seekToEndOfFile(); handle.write(line.data(using: .utf8)!); try? handle.close()
    } else {
      try? line.write(to: logURL, atomically: true, encoding: .utf8)
    }
  }

  /// 로그인 셸의 PATH로 node를 찾는다(nvm·homebrew 등). 못 찾으면 흔한 자리를 직접 본다.
  static func findNode() -> String? {
    let (_, output) = run("/bin/zsh", ["-lc", "command -v node"], timeout: 10)
    let fromShell = output.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.last { $0.hasPrefix("/") }
    let candidates = [fromShell, "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"].compactMap { $0 }
    return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
  }

  static func nodeVersion(_ node: String) -> String {
    run(node, ["--version"], timeout: 5).1.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// 데몬이 없으면 띄운다. CLI의 ensure-daemon과 같은 코드를 쓴다(표면이 데몬을 데리고 다닌다).
  @discardableResult
  static func ensureDaemon(node: String) -> Bool {
    let (status, output) = run(node, [cliScript.path, "ensure-daemon"], env: ["APPROVE_HERE_HOME": home.path], timeout: 15)
    log("ensure-daemon exit=\(status) \(output.trimmingCharacters(in: .whitespacesAndNewlines))")
    return status == 0
  }

  static func stopDaemon(node: String) {
    _ = run(node, [cliScript.path, "stop"], env: ["APPROVE_HERE_HOME": home.path], timeout: 5)
  }

  /// 동기 실행. 표면 UI가 멈추지 않게 호출자는 백그라운드 큐에서 부른다.
  static func run(_ launchPath: String, _ arguments: [String], env: [String: String] = [:], timeout: TimeInterval) -> (Int32, String) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: launchPath)
    process.arguments = arguments
    var environment = ProcessInfo.processInfo.environment
    for (key, value) in env { environment[key] = value }
    process.environment = environment
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = pipe
    do { try process.run() } catch { return (-1, "\(error)") }
    let deadline = DispatchTime.now() + timeout
    let group = DispatchGroup()
    group.enter()
    process.terminationHandler = { _ in group.leave() }
    if group.wait(timeout: deadline) == .timedOut { process.terminate(); return (-2, "timeout") }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    return (process.terminationStatus, String(data: data, encoding: .utf8) ?? "")
  }
}
