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
      let history = try await client.decide(CommandLine.arguments[3], behavior: "deny")
      check(history?.contains("답변은 전달") == true && history?.contains("이력을 저장하지 못") == true, "native client lost history-save failure after denial")
      let answer = try await client.answer(CommandLine.arguments[4], answers: ["selection": "확인"])
      check(answer?.contains("이력을 저장하지 못") == true, "native answer client lost history-save failure")
      let passthrough = try await client.passthrough(CommandLine.arguments[5])
      check(passthrough?.contains("이력을 저장하지 못") == true, "native passthrough client lost history-save failure")
      print("PASS: native client distinguishes reply delivery from storage failures for approval, denial, answer and passthrough")
    } catch { check(false, "native decision client: \(error)") }
  }
}
