import Darwin
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
  static func findNode(candidatePaths: [String]? = nil) -> String? {
    let candidates: [String]
    if let candidatePaths { candidates = candidatePaths }
    else {
      let (_, output) = run("/bin/zsh", ["-lc", "command -v node"], timeout: 10)
      let fromShell = output.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.last { $0.hasPrefix("/") }
      candidates = [fromShell, "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"].compactMap { $0 }
    }
    var seen = Set<String>()
    for path in candidates where seen.insert(path).inserted && FileManager.default.isExecutableFile(atPath: path) {
      let (status, output) = run(path, ["--version"], timeout: 5)
      let version = output.trimmingCharacters(in: .whitespacesAndNewlines)
      guard status == 0, version.hasPrefix("v"), let major = Int(version.dropFirst().split(separator: ".").first ?? ""), major >= 20 else { continue }
      return path
    }
    return nil
  }

  static func nodeVersion(_ node: String) -> String {
    run(node, ["--version"], timeout: 5).1.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// 데몬이 없으면 띄운다. CLI의 ensure-daemon과 같은 코드를 쓴다(표면이 데몬을 데리고 다닌다).
  @discardableResult
  static func ensureDaemon(node: String) -> (status: Int32, output: String) {
    let logURL = home.appendingPathComponent("daemon.log")
    let before = ((try? FileManager.default.attributesOfItem(atPath: logURL.path)[.size]) as? NSNumber)?.uint64Value ?? 0
    let (status, output) = run(node, [cliScript.path, "ensure-daemon"], env: ["APPROVE_HERE_HOME": home.path], timeout: 15)
    var detail = output
    if status != 0, let reader = try? FileHandle(forReadingFrom: logURL) {
      defer { try? reader.close() }
      if let end = try? reader.seekToEnd(), end > before {
        try? reader.seek(toOffset: max(before, end > 4096 ? end - 4096 : 0))
        if let data = try? reader.read(upToCount: 4096) { detail += "\n" + String(decoding: data, as: UTF8.self) }
      }
    }
    log("ensure-daemon exit=\(status) \(detail.trimmingCharacters(in: .whitespacesAndNewlines))")
    return (status, detail)
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
    // Waiting for exit before reading a pipe can deadlock when diagnostics fill it.
    // A private temporary file also avoids waiting for descendants that inherit stdout.
    let outputURL = FileManager.default.temporaryDirectory.appendingPathComponent("approve-here-output-\(UUID().uuidString)")
    guard FileManager.default.createFile(atPath: outputURL.path, contents: nil, attributes: [.posixPermissions: 0o600]),
          let output = try? FileHandle(forWritingTo: outputURL) else {
      try? FileManager.default.removeItem(at: outputURL)
      return (-1, "명령 실행의 출력을 준비하지 못했습니다.")
    }
    defer { try? output.close(); try? FileManager.default.removeItem(at: outputURL) }
    process.standardOutput = output
    process.standardError = output
    let group = DispatchGroup()
    group.enter()
    process.terminationHandler = { _ in group.leave() }
    do { try process.run() } catch {
      process.terminationHandler = nil
      group.leave()
      return (-1, "\(error)")
    }
    let timedOut = group.wait(timeout: .now() + timeout) == .timedOut
    if timedOut {
      if process.isRunning { process.terminate() }
      if group.wait(timeout: .now() + 0.5) == .timedOut {
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        _ = group.wait(timeout: .now() + 1)
      }
    }
    var captured = ""
    if let reader = try? FileHandle(forReadingFrom: outputURL) {
      defer { try? reader.close() }
      let limit = 64 * 1024
      if let size = try? reader.seekToEnd() {
        try? reader.seek(toOffset: 0)
        if size > UInt64(limit) {
          let head = (try? reader.read(upToCount: limit / 2)) ?? Data()
          try? reader.seek(toOffset: size - UInt64(limit / 2))
          let tail = (try? reader.read(upToCount: limit / 2)) ?? Data()
          captured = String(decoding: head, as: UTF8.self) + "\n(중간 출력은 길어서 생략했습니다.)\n" + String(decoding: tail, as: UTF8.self)
        } else if let data = try? reader.read(upToCount: limit) {
          captured = String(decoding: data, as: UTF8.self)
        }
      }
    }
    if timedOut { return (-2, captured + "\n실행 시간이 초과됐습니다.") }
    return (process.terminationStatus, captured)
  }
}
