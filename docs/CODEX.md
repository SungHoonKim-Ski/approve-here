# Codex 앱·CLI 연결

Approve Here의 메뉴에서 **Codex 연결**을 켜면 Codex 훅을 등록하고, 공유 로컬 App Server와 앱 중계 실행기에 연결합니다. 연결된 세션의 승인·질문을 카드에서 처리할 수 있습니다. tmux나 터미널 화면 조작은 필요하지 않습니다.

## Codex 앱의 질문 연결

별도 stdio 서버를 쓰는 Codex 앱은 다음과 같이 연결합니다. 왜 실행기가 필요한지와 증상별 확인은 [README의 Codex 앱 연결](../README.md#codex-앱-연결)에 있고, 여기는 동작 조건을 적습니다.

1. Approve Here 0.5.0 이상의 메뉴에서 **Codex 앱 중계 실행기 설치…**를 선택합니다.
2. 진행 중인 작업을 마친 뒤 Codex 앱을 완전히 종료합니다.
3. `~/Applications/Codex with Approve Here.app`을 엽니다. 이후에도 이 실행기로 Codex를 여세요.
4. 메뉴에 **앱 중계 1개 연결됨**이 나타나는지 확인합니다. CLI의 `approve-here status`도 중계 연결 수를 보여 줍니다.

중계 실행기는 원래 앱에 포함된 Codex 실행 파일과 stdio 서버를 그대로 사용합니다. 모델, 승인 모드, 샌드박스, 설정 파일을 바꾸지 않습니다. `CODEX_CLI_PATH`를 별도 중계 파일로 지정하는 것은 이 실행기로 연 앱 프로세스에만 적용됩니다. 원래 앱으로 다시 열면 기존 실행 방식으로 돌아갑니다. 실행기 설치만으로 이미 실행 중인 앱의 연결이 바뀌지는 않습니다.

터미널에서 설치하려면 `approve-here install-codex-launcher`를 실행하세요. 다른 앱·설치 위치는 `--app /Applications/Codex.app --target "$HOME/Applications/Codex with Approve Here.app"`으로 지정합니다. 설치한 실행기는 원래 앱을 덮어쓰지 않습니다. 원래 앱을 이동하거나 실행 파일 경로가 바뀌면 실행기를 다시 설치하세요.

배포 앱에는 미리 빌드한 실행기가 포함됩니다. 앱의 메뉴나 시작 안내에서 설치할 때는 Xcode·Command Line Tools가 필요하지 않으며, 설치 경로만 별도 설정 파일에 기록합니다. 실행기 파일이 누락된 배포 앱은 개발 도구 설치를 요구하지 않고 앱을 다시 내려받도록 안내합니다.

npm으로만 설치한 CLI는 실행기를 로컬에서 빌드하므로 macOS Command Line Tools의 Swift 컴파일러가 필요합니다. 이 경우에만 `xcode-select --install`로 개발 도구를 설치하세요. 실행기 생성이 끝나기 전에는 기존 실행기를 교체하지 않으며, 실패해도 다시 설치할 수 있습니다.

실행 후 Node.js 경로가 사라졌거나 중계 파일을 찾지 못하면 원래 Codex 실행 파일로 돌아갑니다. 이때 질문은 원래 앱 안에서 받습니다. Approve Here와 Node.js를 다시 준비한 뒤 실행기를 다시 설치하면 중계를 복구할 수 있습니다.

카드와 원래 앱에서 모두 답할 수 있으며 먼저 답한 쪽만 Codex에 전달됩니다. Approve Here가 꺼지거나 연결이 끊겨도 원래 앱 화면은 계속 사용할 수 있습니다. 비밀 질문·지원하지 않는 요청·큰 입력 전달 중의 요청은 원래 앱에서 처리합니다.

Codex가 거부 대신 취소만 허용하는 승인 요청은 **거부** 버튼을 누르면 해당 턴을 취소합니다.

Codex에서 새 훅을 검토·신뢰하세요. 공유 App Server에 연결된 요청은 훅 카드와 중복되지 않게 App Server가 전달합니다. 공유 서버가 없는 CLI에서도 기존 PermissionRequest 훅을 통한 승인은 계속 동작합니다.

권한 훅은 현재 턴의 Codex 실행 기록(`turn_context`)에서 승인 검토자를 확인합니다. `auto_review` 또는 `guardian_subagent`(Codex의 “나 대신 승인”)이면 카드 응답을 기다리지 않고 Codex의 자동 검토로 인계합니다. 별도 stdio 서버를 사용하는 앱에서도 적용됩니다. 현재 턴의 기록을 읽지 못하면 공유 서버의 세션 설정을 확인하며, 어느 쪽에서도 모드를 확인하지 못하면 기존 카드 경로를 사용합니다. 사용자 메시지나 설정 파일의 기본값으로 모드를 추측하지 않습니다.

## 지원하는 동작

- 명령 실행 허용·거부, 파일 변경 허용·거부, 요청된 네트워크·파일 접근 권한 허용·거부
- 명령 접두를 기억하는 “앞으로 자동”, 기존 allowlist와 Codex 정책 훅
- 선택형 질문, 선택지 밖의 자유 입력, 여러 질문의 개별 답변
- 원래 Codex 화면에서 답하거나 취소했을 때 카드 정리
- 연결 종료 시 카드 인계, 재연결 시 아직 대기 중인 요청 다시 받기

질문은 문구가 같아도 Codex 질문 ID로 구분합니다. 비밀 입력 질문과 알 수 없는 요청은 원래 화면에서 처리합니다. 질문 카드의 ✕는 Codex에 답을 보내지 않고 카드만 인계합니다.

Codex CLI 0.157.1에서 `request_user_input` 질문은 Plan 모드에서 확인했습니다. CLI 입력창에 `/plan`을 입력해 전환할 수 있습니다. 기본 모드에서 `request_user_input`이 제공되지 않아 다른 입력 도구로 전환된 질문은 이 경로의 카드로 등록되지 않았습니다. [OpenAI의 Plan 모드 안내](https://developers.openai.com/blog/run-long-horizon-tasks-with-codex)에도 `/plan` 전환 방법이 있습니다.

## 연결 조건과 확인

공유 서버 방식은 같은 사용자·같은 `CODEX_HOME`의 App Server를 사용해야 합니다. 기본 접점은 `~/.codex/app-server-control/app-server-control.sock`입니다. 앱 중계 방식은 같은 `APPROVE_HERE_HOME`의 `codex-relays` 폴더를 사용합니다. 중계 소켓과 폴더는 현재 사용자만 접근할 수 있습니다.

Codex CLI 0.157.1에서 `--no-daemon`, `--profile` 또는 `-c approvals_reviewer=...` 같은 서버 설정 오버라이드를 사용하면 공유 서버 대신 CLI 내부 서버를 사용합니다. 이 세션의 승인은 기존 훅으로 처리하지만 질문은 원래 CLI에서 받습니다. 질문 카드가 필요하면 공유 서버를 사용하는 일반 실행으로 여세요. [Codex의 공유 서버 제외 조건](https://github.com/openai/codex/blob/main/codex-rs/tui/src/daemon_startup.rs)에 따라 다른 `-c` 옵션도 영향을 줄 수 있습니다.

Approve Here가 활성 상태이고 Codex 연결이 켜져 있을 때만 서버에 연결합니다. 이미 메모리에 올라온 세션 목록을 읽고 `thread/resume`으로 해당 세션에 추가 연결합니다. 모델, 샌드박스, 승인 정책을 바꾸거나 새 대화를 시작하지 않습니다.

`approve-here status`로 공유 서버 연결 상태와 앱 중계 연결 수를 확인합니다. **공유 서버만 연결됐다는 표시로 현재 앱 대화까지 연결된 것은 아닙니다.** 별도 stdio 앱의 질문은 중계 실행기로 앱을 열었을 때 연결됩니다. 원래 실행 방식에서는 권한 훅과 “나 대신 승인” 인계가 동작하고 질문은 원래 앱에서 받습니다.

Codex CLI 0.157.1의 실제 공유 서버에서 질문 생성 → 빌드된 앱 코어의 대기함 → 답변 → 모델의 답변 확인까지 검증했습니다. 명령 허용과 거부도 같은 번들에서 검증했으며, 이 CLI에서는 거부가 턴 취소로 표시됐습니다. 아직 실행 기록이 없는 새 세션의 추가 연결 실패는 다른 세션의 연결을 끊지 않습니다. 별도 stdio 서버의 실제 앱 대화에서는 권한 요청이 카드 없이 자동 검토로 인계되는 것을 확인했습니다.

Node 테스트는 App Server의 Unix 소켓·WebSocket·JSON RPC와 원래 stdio의 응답 경합·취소·연결 종료를 검증합니다. App Server API와 앱의 실행 파일 지정 방식은 버전에 따라 바뀔 수 있습니다. 근거: [공식 App Server 문서](https://learn.chatgpt.com/docs/app-server), [실행 중인 세션의 추가 연결과 대기 요청 재전송](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/request_processors/thread_lifecycle.rs), [로컬 소켓 WebSocket 전송](https://github.com/openai/codex/blob/main/codex-rs/app-server-transport/src/transport/unix_socket.rs).

연결을 끄거나 `~/.approve-here/config.json`에 `"codexAppServer": false`를 설정하면 App Server 연결은 중단됩니다. 저장한 승인 규칙은 `~/.approve-here/allowlist.json`에서 확인할 수 있습니다.
