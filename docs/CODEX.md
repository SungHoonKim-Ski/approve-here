# Codex 앱·CLI 연결

Approve Here의 메뉴에서 **Codex 연결**을 켜면 Codex 훅을 등록하고, 실행 중인 공유 로컬 App Server에도 연결합니다. Codex 앱과 이 서버에 연결된 CLI 세션의 승인·질문을 카드에서 처리할 수 있습니다. tmux나 터미널 화면 조작은 필요하지 않습니다.

Codex에서 새 훅을 검토·신뢰하세요. 공유 App Server에 연결된 요청은 훅 카드와 중복되지 않게 App Server가 전달합니다. 공유 서버가 없는 CLI에서도 기존 PermissionRequest 훅을 통한 승인은 계속 동작합니다.

권한 훅은 현재 턴의 Codex 실행 기록(`turn_context`)에서 승인 검토자를 확인합니다. `auto_review` 또는 `guardian_subagent`(Codex의 “나 대신 승인”)이면 카드 응답을 기다리지 않고 Codex의 자동 검토로 인계합니다. 별도 stdio 서버를 사용하는 앱에서도 적용됩니다. 현재 턴의 기록을 읽지 못하면 공유 서버의 세션 설정을 확인하며, 어느 쪽에서도 모드를 확인하지 못하면 기존 카드 경로를 사용합니다. 사용자 메시지나 설정 파일의 기본값으로 모드를 추측하지 않습니다.

## 지원하는 동작

- 명령 실행 허용·거부, 파일 변경 허용·거부, 요청된 네트워크·파일 접근 권한 허용·거부
- 명령 접두를 기억하는 “앞으로 자동”, 기존 allowlist와 Codex 정책 훅
- 선택형 질문, 선택지 밖의 자유 입력, 여러 질문의 개별 답변
- 원래 Codex 화면에서 답하거나 취소했을 때 카드 정리
- 연결 종료 시 카드 인계, 재연결 시 아직 대기 중인 요청 다시 받기

질문은 문구가 같아도 Codex 질문 ID로 구분합니다. 비밀 입력 질문과 알 수 없는 요청은 원래 화면에서 처리합니다. 질문 카드의 ✕는 Codex에 답을 보내지 않고 카드만 인계합니다.

## 연결 조건과 확인

같은 사용자·같은 `CODEX_HOME`의 공유 App Server를 사용해야 합니다. 기본 접점은 `~/.codex/app-server-control/app-server-control.sock`입니다. 환경 변수 `CODEX_HOME`을 설정했다면 Approve Here와 Codex가 같은 값을 사용해야 합니다.

Approve Here가 활성 상태이고 Codex 연결이 켜져 있을 때만 서버에 연결합니다. 이미 메모리에 올라온 세션 목록을 읽고 `thread/resume`으로 해당 세션에 추가 연결합니다. 모델, 샌드박스, 승인 정책을 바꾸거나 새 대화를 시작하지 않습니다.

`approve-here status`로 공유 서버 연결 상태를 확인합니다. **서버가 연결됐다는 표시만으로 현재 앱 대화까지 연결된 것은 아닙니다.** 별도 stdio 서버를 쓰는 앱의 질문에는 이 경로가 닿지 않으며, 앱을 업데이트해도 같은 실행 방식을 사용하면 달라지지 않습니다. 해당 앱에서는 권한 훅과 “나 대신 승인” 인계가 동작하고 질문은 원래 앱에서 받습니다.

Codex CLI 0.157.1의 실제 공유 서버에서 질문 생성 → 설치된 Approve Here 대기함 → 답변 → 모델의 답변 확인까지 검증했습니다. 아직 실행 기록이 없는 새 세션의 추가 연결 실패는 다른 세션의 연결을 끊지 않습니다. 별도 stdio 서버의 실제 앱 대화에서는 권한 요청이 카드 없이 자동 검토로 인계되는 것을 확인했습니다.

Node 테스트는 App Server의 Unix 소켓·WebSocket·JSON RPC를 재현해 카드 등록부터 답변 전달까지 검증합니다. App Server API는 버전에 따라 바뀔 수 있습니다. 근거: [공식 App Server 문서](https://learn.chatgpt.com/docs/app-server), [실행 중인 세션의 추가 연결과 대기 요청 재전송](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/request_processors/thread_lifecycle.rs), [로컬 소켓 WebSocket 전송](https://github.com/openai/codex/blob/main/codex-rs/app-server-transport/src/transport/unix_socket.rs).

연결을 끄거나 `~/.approve-here/config.json`에 `"codexAppServer": false`를 설정하면 App Server 연결은 중단됩니다. 저장한 승인 규칙은 `~/.approve-here/allowlist.json`에서 확인할 수 있습니다.
