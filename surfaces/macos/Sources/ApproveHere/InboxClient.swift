import Foundation

/// 데몬 API 클라이언트. 표면은 이 계약만 소비한다 — 판단 로직은 없다.
struct PendingRequest: Decodable, Identifiable, Equatable {
  struct Tmux: Decodable, Equatable {
    let pane: String?
    let title: String?
  }
  struct Context: Decodable, Equatable {
    let task: String?
    let latest: String?
    /// 질문 직전에 agent가 한 설명 — 질문의 배경.
    let assistant: String?
  }
  struct Option: Decodable, Equatable {
    let label: String
    let description: String?
  }
  struct Question: Decodable, Equatable {
    let id: String?
    var answerKey: String { id ?? question }
    let question: String
    let header: String?
    let options: [Option]?
    let multiSelect: Bool?
  }

  let id: String
  let kind: String?
  let sessionId: String?
  let provider: String
  let project: String?
  let toolName: String
  let toolInput: [String: AnyCodable]
  let questions: [Question]?
  let description: String?
  let createdAt: String
  let tmux: Tmux?
  let context: Context?
  /// wait: 훅이 카드 결정을 기다림 · mirror: 터미널 다이얼로그도 떠 있고 먼저 답한 쪽이 이김
  let mode: String?
  /// wait 모드에서 이 시각이 지나면 훅이 물러나 터미널에 원래 프롬프트가 뜬다.
  let handoffAt: String?

  var isQuestion: Bool { kind == "question" }
  var isMirror: Bool { mode == "mirror" }
  var isCodexDirect: Bool { mode == "codex" }

  var handoffDate: Date? { handoffAt.flatMap { ISO8601DateFormatter.withFractions.date(from: $0) ?? ISO8601DateFormatter().date(from: $0) } }

  /// 어느 세션인지 알아보는 한 줄: tmux 창 이름이 있으면 그것, 없으면 마지막 사용자 요청.
  var sessionLine: String? {
    if let title = tmux?.title, !title.isEmpty { return title }
    return context?.latest ?? context?.task
  }

  /// 그 세션이 지금 하고 있는 일(마지막 사용자 요청). 창 이름과 같으면 생략.
  var workingOn: String? {
    guard let latest = context?.latest ?? context?.task, latest != tmux?.title else { return nil }
    return latest
  }

  var summary: String {
    if case .string(let command)? = toolInput["command"] { return command.replacingOccurrences(of: "\n", with: " ") }
    if case .string(let path)? = toolInput["file_path"] { return "\(toolName) \(path)" }
    if isQuestion { return (questions ?? []).map(\.question).joined(separator: " / ") }
    return toolName
  }

  /// "앞으로 자동"에 쓸 명령 접두. 되돌릴 수 없는 명령은 접두로 기억시키지 않는다 — 버튼 자체를 내놓지 않는다.
  var commandPrefix: String? {
    guard case .string(let command)? = toolInput["command"] else { return nil }
    let words = command.split(separator: " ").map(String.init)
    guard let first = words.first, !PendingRequest.neverRemember.contains(first) else { return nil }
    return words.prefix(2).joined(separator: " ")
  }

  static let neverRemember: Set<String> = ["rm", "sudo", "dd", "mkfs", "kill", "killall", "shutdown", "reboot", "chmod", "chown", "curl", "wget"]
}

extension ISO8601DateFormatter {
  static let withFractions: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
  }()
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

struct CodexConnectionStatus: Decodable { let connected: Bool; let error: String? }
struct InboxHealth: Decodable { let codexAppServer: CodexConnectionStatus? }

struct DaemonInfo: Decodable { let port: Int }

final class InboxClient {
  private let home: URL
  private var port: Int?
  private var token: String?

  init() { home = Runtime.home }

  /// daemon.json·token은 데몬이 다시 뜨면 바뀔 수 있어 매번 읽는다. 기록 파일이 없으면 설정 포트(기본 4400)로 붙는다.
  private func reload() -> Bool {
    guard let tokenText = try? String(contentsOf: home.appendingPathComponent("token"), encoding: .utf8) else { return false }
    token = tokenText.trimmingCharacters(in: .whitespacesAndNewlines)
    if let data = try? Data(contentsOf: home.appendingPathComponent("daemon.json")),
       let info = try? JSONDecoder().decode(DaemonInfo.self, from: data) {
      port = info.port
    } else {
      port = configuredPort()
    }
    return true
  }

  private func configuredPort() -> Int {
    if let data = try? Data(contentsOf: home.appendingPathComponent("config.json")),
       let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       let value = json["port"] as? Int, value > 0 {
      return value
    }
    return 4400
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

  func codexStatus() async throws -> CodexConnectionStatus? {
    try JSONDecoder().decode(InboxHealth.self, from: try await request("/health")).codexAppServer
  }

  func pending() async throws -> [PendingRequest] {
    try JSONDecoder().decode([PendingRequest].self, from: try await request("/requests?status=pending"))
  }

  func decide(_ id: String, behavior: String, remember prefix: String? = nil) async throws {
    var body: [String: Any] = ["behavior": behavior]
    if let prefix { body["remember"] = ["commandPrefix": prefix] }
    _ = try await request("/requests/\(id)/decision", method: "POST", body: body)
  }

  /// 질문 카드의 답. {질문 원문: 고른 라벨 또는 직접 입력}. multiSelect는 라벨을 ", "로 잇는다.
  func answer(_ id: String, answers: [String: String]) async throws {
    _ = try await request("/requests/\(id)/decision", method: "POST", body: ["answers": answers])
  }

  /// 질문을 앱에서 답하지 않고 그 세션의 원래 다이얼로그로 넘긴다.
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
