import Foundation
import Darwin

@main
struct DecisionClientSmoke {
  static func check(_ value: Bool, _ message: String) {
    if !value { FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8)); exit(1) }
  }
  static func main() async {
    do {
      let client = InboxClient()
      let warning = try await client.decide(CommandLine.arguments[1], behavior: "allow", remember: "npm test")
      check(warning?.contains("이번 요청은 허용") == true && warning?.contains("저장하지 못") == true, "native client lost rule-save failure")
      let normal = try await client.decide(CommandLine.arguments[2], behavior: "allow")
      check(normal == nil, "normal approval must not have a warning")
      print("PASS: native client distinguishes delivered approval with rule-save failure from normal approval")
    } catch { check(false, "native decision client: \(error)") }
  }
}
