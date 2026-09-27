import AppKit
import Darwin
import Foundation

struct LauncherConfiguration: Decodable {
  let appBinary: String
  let realCli: String
  let processName: String
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("\(message)\n".utf8))
  if ProcessInfo.processInfo.environment["APPROVE_HERE_LAUNCHER_NO_ALERT"] != "1" && isatty(STDERR_FILENO) == 0 {
    _ = NSApplication.shared
    NSApp.setActivationPolicy(.accessory)
    NSApp.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.messageText = "Codex 실행기를 열지 못했습니다"
    alert.informativeText = message
    alert.addButton(withTitle: "닫기")
    alert.runModal()
  }
  exit(1)
}

let executable = URL(fileURLWithPath: CommandLine.arguments[0])
let configURL = executable.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Resources/launcher.json")
let config: LauncherConfiguration
do {
  config = try JSONDecoder().decode(LauncherConfiguration.self, from: Data(contentsOf: configURL))
} catch {
  fail("실행기 설정을 읽을 수 없습니다. Approve Here의 시작 안내에서 Codex 앱 실행기를 다시 설치해 주세요.")
}

guard FileManager.default.isExecutableFile(atPath: config.appBinary),
      FileManager.default.isExecutableFile(atPath: config.realCli) else {
  fail("연결한 Codex 앱의 실행 파일을 찾을 수 없습니다. Codex 앱을 설치하거나 업데이트한 뒤 실행기를 다시 설치해 주세요.")
}

let guardProcess = Process()
guardProcess.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
guardProcess.arguments = ["-x", config.processName]
guardProcess.standardOutput = FileHandle.nullDevice
guardProcess.standardError = FileHandle.nullDevice
do {
  try guardProcess.run()
  guardProcess.waitUntilExit()
} catch {
  fail("Codex 앱의 실행 상태를 확인하지 못했습니다. 잠시 뒤 실행기를 다시 열어 주세요.")
}
if guardProcess.terminationStatus == 0 {
  fail("Codex 앱을 완전히 종료한 뒤 이 실행기를 여세요. 창만 닫지 말고 Codex 메뉴의 종료 또는 ⌘Q를 사용해 주세요.")
}
if guardProcess.terminationStatus != 1 {
  fail("Codex 앱의 실행 상태를 확인하지 못했습니다. 실행기를 다시 설치해 주세요.")
}

let rawExecutable = CommandLine.arguments[0]
let absoluteExecutable = rawExecutable.hasPrefix("/") ? rawExecutable : FileManager.default.currentDirectoryPath + "/" + rawExecutable
guard let slash = absoluteExecutable.lastIndex(of: "/") else { fail("실행기 경로를 찾을 수 없습니다. 실행기를 다시 설치해 주세요.") }
let shim = String(absoluteExecutable[..<slash]) + "/codex-shim"
guard setenv("APPROVE_HERE_CODEX_CLI", config.realCli, 1) == 0,
      setenv("CODEX_CLI_PATH", shim, 1) == 0 else {
  fail("Codex 실행 환경을 준비하지 못했습니다. 잠시 뒤 실행기를 다시 열어 주세요.")
}
// Foundation Process converts strings through filesystem representation on macOS.
// execv preserves the UTF-8 bytes of ordinary arguments as well as paths.
var arguments = ([config.appBinary] + Array(CommandLine.arguments.dropFirst())).map { value in
  value.withCString { strdup($0) }
}
guard arguments.allSatisfy({ $0 != nil }) else {
  for argument in arguments { free(argument) }
  fail("Codex 실행 인자를 준비하지 못했습니다. 잠시 뒤 실행기를 다시 열어 주세요.")
}
arguments.append(nil)
config.appBinary.withCString { path in
  arguments.withUnsafeMutableBufferPointer { buffer in
    _ = execv(path, buffer.baseAddress!)
  }
}
for argument in arguments { free(argument) }
fail("Codex 앱을 실행하지 못했습니다. Codex 앱을 직접 열 수 있는지 확인한 뒤 실행기를 다시 설치해 주세요.")
