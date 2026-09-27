import Foundation

@main
struct RulesClientSmoke {
  static func main() async throws {
    let client = InboxClient()
    let rules = try await client.automaticRules()
    precondition(rules.count == 2)
    precondition(rules[0].command == "npm test")
    precondition(rules[0].scope == "Codex · Bash")
    let remaining = try await client.removeAutomaticRule(rules[0])
    precondition(remaining.count == 1)
    precondition(remaining[0].scope == "Claude Code · Bash")
    do {
      _ = try await client.removeAutomaticRule(rules[0])
      fatalError("stale deletion was accepted")
    } catch InboxError.http(409, _) { }
    let reloaded = try await client.automaticRules()
    precondition(reloaded.count == 1)
    print("PASS: native client loads rules, preserves raw metadata, removes only selected rule and rejects stale removal")
  }
}
