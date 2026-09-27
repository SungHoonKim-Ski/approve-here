import Foundation
import Darwin

@main
struct StartupSmoke {
  static func check(_ value: Bool, _ message: String) {
    if !value { FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8)); exit(1) }
  }

  static func configure(port: Int) throws {
    let data = try JSONSerialization.data(withJSONObject: ["port": port, "codexAppServer": false, "idleExitSeconds": 0])
    try data.write(to: Runtime.home.appendingPathComponent("config.json"))
  }

  static func health() async -> Bool {
    guard let data = try? Data(contentsOf: Runtime.home.appendingPathComponent("daemon.json")),
          let info = try? JSONDecoder().decode(DaemonPort.self, from: data),
          let url = URL(string: "http://127.0.0.1:\(info.port)/health") else { return false }
    var request = URLRequest(url: url)
    request.timeoutInterval = 1
    guard let (_, response) = try? await URLSession.shared.data(for: request) else { return false }
    return (response as? HTTPURLResponse)?.statusCode == 200
  }

  static func stop(_ node: String) async {
    Runtime.stopDaemon(node: node)
    for _ in 0..<30 {
      if !(await health()) { return }
      try? await Task.sleep(nanoseconds: 100_000_000)
    }
    check(false, "isolated daemon did not stop")
  }

  static func main() async {
    do { try await run() }
    catch { check(false, "startup fixture failed: \(error)") }
  }

  static func run() async throws {
    let node = CommandLine.arguments[1]
    let occupied = Int(CommandLine.arguments[2])!
    check(Runtime.coreBundled, "test must use the built app's actual core")
    let started = Runtime.ensureDaemon(node: node)
    check(started.status == 0, "fresh daemon startup failed: \(started.output)")
    let alive = await health()
    check(alive, "native startup must create a reachable daemon")
    await stop(node)
    do { try FileManager.default.removeItem(at: Runtime.home.appendingPathComponent("daemon.json")) }
    catch let error as CocoaError where error.code == .fileNoSuchFile { }

    try "{broken".write(to: Runtime.home.appendingPathComponent("config.json"), atomically: true, encoding: .utf8)
    let invalid = Runtime.ensureDaemon(node: node)
    check(invalid.status != 0 && invalid.output.contains("config.json"), "invalid config failure must retain its cause")

    try configure(port: occupied)
    let conflict = Runtime.ensureDaemon(node: node)
    check(conflict.status != 0 && conflict.output.contains("EADDRINUSE"), "port conflict must include the new daemon log's actual cause")

    try configure(port: 0)
    let recovered = Runtime.ensureDaemon(node: node)
    check(recovered.status == 0, "recovery failed: \(recovered.output)")
    let ready = await health()
    check(ready, "recovery must restore a reachable daemon")
    await stop(node)
    print("PASS: native runtime starts actual bundled core, reports invalid config and occupied port, recovers and stops its isolated daemon")
  }
}

struct DaemonPort: Decodable { let port: Int }
