import AppKit
import Carbon

/// 메뉴바 아이콘 없이도 메뉴를 부르는 전역 단축키.
/// macOS는 상태 아이콘이 메뉴바 폭을 넘치면 왼쪽부터 조용히 숨기고(노치 노트북은 특히 좁다), 앱이 자기 아이콘을 고정할 방법은 없다.
/// Carbon의 RegisterEventHotKey는 접근성 권한 없이 어느 앱이 앞에 있어도 눌림을 받는다. 기본은 ⌥⇧A(A = Approve).
final class GlobalHotkey {
  static let label = "⌥⇧A"
  private var hotKeyRef: EventHotKeyRef?
  private var handlerRef: EventHandlerRef?
  private let handler: () -> Void

  init(keyCode: UInt32 = UInt32(kVK_ANSI_A), modifiers: UInt32 = UInt32(optionKey | shiftKey), handler: @escaping () -> Void) {
    self.handler = handler
    var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    // C 콜백은 컨텍스트를 못 잡으므로 self를 userData로 넘긴다. 이 객체는 앱과 수명이 같다.
    let installed = InstallEventHandler(GetApplicationEventTarget(), { _, _, userData in
      guard let userData else { return noErr }
      Unmanaged<GlobalHotkey>.fromOpaque(userData).takeUnretainedValue().handler()
      return noErr
    }, 1, &eventType, Unmanaged.passUnretained(self).toOpaque(), &handlerRef)
    let id = EventHotKeyID(signature: 0x4150_4856 /* APHV */, id: 1)
    let registered = RegisterEventHotKey(keyCode, modifiers, id, GetApplicationEventTarget(), 0, &hotKeyRef)
    Runtime.log("hotkey \(GlobalHotkey.label) handler=\(installed) register=\(registered)")
  }

  deinit {
    if let hotKeyRef { UnregisterEventHotKey(hotKeyRef) }
    if let handlerRef { RemoveEventHandler(handlerRef) }
  }
}
