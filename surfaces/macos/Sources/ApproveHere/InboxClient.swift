import Foundation

/// 데몬 API 클라이언트. 표면은 이 계약만 소비한다 — 판단 로직은 없다.
struct PendingRequest: Decodable, Identifiable, Equatable {
  struct Tmux: Decodable, Equatable { let pane: String? }
  struct Option: Decodable, Equatable {
    let label: String
    let description: String?
  }
  struct Question: Decodable, Equatable {
    let question: String
    let header: String?
    let options: [Option]?
    let multiSelect: Bool?
  }

  let id: String
  let kind: String?
  let provider: String
  let project: String?
  let toolName: String
  let toolInput: [String: AnyCodable]
  let questions: [Question]?
  let description: String?
  let createdAt: String
  let tmux: Tmux?

  var isQuestion: Bool { kind == "question" }

  var summary: String {
    if case .string(let command)? = toolInput["command"] { return command.replacingOccurrences(of: "\n", with: " ") }
    if case .string(let path)? = toolInput["file_path"] { return "\(toolName) \(path)" }
    if isQuestion { return (questions ?? []).map(\.question).joined(separator: " / ") }
    return toolName
  }

  var commandPrefix: String? {
    guard case .string(let command)? = toolInput["command"] else { return nil }
    let words = command.split(separator: " ").map(String.init)
    return words.prefix(2).joined(separator: " ")
  }
}

/// tool_input은 도구마다 모양이 달라 느슨하게 받는다.
enum AnyCodable: Decodable, Equatable {
  case string(String), number(Double), bool(Bool), null, other

  init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() { self = .null }
    else if let s = try? c.decode(String.self) { self = .string(s) }
    else if let b = try? c.decode(Bool.self) { self = .bool(b) }
    else if let n = try? c.decode(Double.self) { self = .number(n) }
    else { self = .other }
  }
}

struct DaemonInfo: Decodable { let port: Int }

final class InboxClient {
  private let home: URL
  private var port: Int?
  private var token: String?

  init() { home = Runtime.home }

  /// daemon.json·token은 데몬이 다시 뜨면 바뀔 수 있어 매번 읽는다.
  private func reload() -> Bool {
    guard let data = try? Data(contentsOf: home.appendingPathComponent("daemon.json")),
          let info = try? JSONDecoder().decode(DaemonInfo.self, from: data),
          let tokenText = try? String(contentsOf: home.appendingPathComponent("token"), encoding: .utf8)
    else { return false }
    port = info.port
    token = tokenText.trimmingCharacters(in: .whitespacesAndNewlines)
    return true
  }

  private func request(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> Data {
    guard reload(), let port, let token else { throw InboxError.daemonUnavailable }
    var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)\(path)")!)
    req.httpMethod = method
    req.timeoutInterval = 5
    req.setValue(token, forHTTPHeaderField: "x-approve-here-token")
    if let body {
      req.setValue("application/json", forHTTPHeaderField: "content-type")
      req.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    let (data, response) = try await URLSession.shared.data(for: req)
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      throw InboxError.http((response as? HTTPURLResponse)?.statusCode ?? -1)
    }
    return data
  }

  func pending() async throws -> [PendingRequest] {
    try JSONDecoder().decode([PendingRequest].self, from: try await request("/requests?status=pending"))
  }

  func decide(_ id: String, behavior: String, remember prefix: String? = nil) async throws {
    var body: [String: Any] = ["behavior": behavior]
    if let prefix { body["remember"] = ["commandPrefix": prefix] }
    _ = try await request("/requests/\(id)/decision", method: "POST", body: body)
  }

  /// 질문 카드의 답. {질문 원문: 고른 라벨}. multiSelect는 라벨을 ", "로 잇는다.
  func answer(_ id: String, answers: [String: String]) async throws {
    _ = try await request("/requests/\(id)/decision", method: "POST", body: ["answers": answers])
  }

  /// 질문을 앱에서 답하지 않고 그 세션 터미널의 원래 다이얼로그로 넘긴다.
  func passthrough(_ id: String) async throws {
    _ = try await request("/requests/\(id)/decision", method: "POST", body: ["passthrough": true])
  }

  func jump(_ id: String) async throws {
    _ = try await request("/requests/\(id)/jump", method: "POST")
  }
}

enum InboxError: Error {
  case daemonUnavailable
  case http(Int)
}
