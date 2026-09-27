import Darwin
import Foundation

@main
struct RuntimeSmoke {
  static func check(_ value: Bool, _ message: String = "runtime check failed") {
    if !value {
      FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
      exit(1)
    }
  }
  static func main() {
    if CommandLine.arguments.contains("--large-output") {
      FileHandle.standardError.write(Data("begin\n".utf8))
      FileHandle.standardOutput.write(Data(repeating: 65, count: 1024 * 1024))
      FileHandle.standardError.write(Data("\nend\n".utf8))
      return
    }
    if CommandLine.arguments.contains("--ignore-terminate") {
      signal(SIGTERM, SIG_IGN)
      FileHandle.standardOutput.write(Data("child-pid=\(getpid())\n".utf8))
      while true { pause() }
    }
    let executable = CommandLine.arguments[0]
    let large = Runtime.run(executable, ["--large-output"], timeout: 3)
    check(large.0 == 0, "large output must not fill a pipe and time out")
    check(large.1.hasPrefix("begin\n"), "stderr must also be captured")
    check(large.1.hasSuffix("\nend\n"), "final diagnostics must survive truncation")
    check(large.1.utf8.count < 1024 * 1024, "diagnostic output must be bounded")
    let started = Date()
    let timedOut = Runtime.run(executable, ["--ignore-terminate"], timeout: 1)
    check(timedOut.0 == -2)
    check(Date().timeIntervalSince(started) < 4, "ignored SIGTERM must not block the app")
    guard let line = timedOut.1.split(separator: "\n").first(where: { $0.hasPrefix("child-pid=") }),
          let pid = Int32(line.dropFirst("child-pid=".count)) else { check(false, "timeout output was lost"); return }
    check(kill(pid, 0) == -1 && errno == ESRCH, "timed-out child must be reaped")
    let normal = Runtime.run("/bin/echo", ["ready"], timeout: 2)
    check(normal.0 == 0 && normal.1 == "ready\n")
    check(Runtime.run("/does-not-exist", [], timeout: 1).0 == -1)
    do {
      let root = FileManager.default.temporaryDirectory.appendingPathComponent("node-fixtures-\(UUID().uuidString)")
      try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: root) }
      var paths: [String] = []
      for (name, version, status) in [("old-node", "v18.20.0", 0), ("broken-node", "v25.0.0", 1), ("supported-node", "v20.0.0", 0)] {
        let path = root.appendingPathComponent(name)
        try "#!/bin/sh\nprintf '%s\\n' '\(version)'\nexit \(status)\n".write(to: path, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: path.path)
        paths.append(path.path)
      }
      check(Runtime.findNode(candidatePaths: paths) == paths[2], "old and failed node must be skipped")
      check(Runtime.findNode(candidatePaths: Array(paths.prefix(2))) == nil, "unsupported runtimes must not be used")
    } catch { check(false, "node fixture creation failed: \(error)") }
    print("PASS: large output completes; diagnostics bounded; ignored termination killed and reaped; normal and missing executables handled")
  }
}
