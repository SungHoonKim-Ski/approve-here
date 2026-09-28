# Approve Here

Claude Code와 Codex CLI 여러 세션의 **승인 요청과 질문을 한곳에서** 받는 macOS 메뉴바 앱입니다. 요청이 오면 화면 오른쪽 위에 카드가 뜹니다.

![승인 카드와 질문 카드](docs/cards.png)

**지원 환경:** Apple Silicon Mac · macOS 13 이상 · Node.js 20 이상. Node.js는 앱에 포함되지 않습니다. Codex 데스크톱 앱 연결은 [실험적 기능](#codex-앱-연결)입니다.

## 시작하기

1. [최신 릴리스](https://github.com/SungHoonKim-Ski/approve-here/releases/latest)에서 **ApproveHere.dmg**를 내려받아 열고, 앱을 **Applications**로 끌어 넣습니다.
2. Applications에서 앱을 엽니다. 서명·공증되지 않은 앱이라 macOS가 막으면 **완료 → 시스템 설정 → 개인정보 보호 및 보안 → 그래도 열기 → 열기** 순서로 진행합니다. DMG 안의 **설치 안내**에 화면별 설명이 있습니다.
3. 시작 안내에서 Node.js가 없다고 나오면 안내의 내려받기 버튼으로 설치하고 **설치 후 다시 찾기**를 누릅니다.
4. 시작 안내에서 사용하는 에이전트의 **Claude Code 연결** 또는 **Codex 연결**을 누릅니다. Codex가 처음 훅 신뢰를 물으면 내용을 확인한 뒤 신뢰합니다.

이제 에이전트가 실제로 허락을 구하거나 질문하면 카드가 나타납니다. 연결 버튼은 훅 등록 상태이고, 현재 세션 연결 상태는 메뉴바 메뉴에서 확인할 수 있습니다. Codex CLI 선택형 질문은 `/plan`으로 Plan 모드를 켠 뒤 `request_user_input`을 사용할 때 카드로 옵니다.

첫 실행이 막히거나 화면을 따라 설치하고 싶다면 [그림으로 보는 사용 가이드](docs/GUIDE.md)를 보세요.

## 카드 사용하기

| 카드 | 할 수 있는 일 |
|---|---|
| 승인 | **허용**, **거부**, **허용 + 앞으로 자동** 중 선택합니다. 자동 승인 규칙은 메뉴의 **자동 승인 관리…**에서 개별 해제할 수 있습니다. |
| 질문 | 선택지를 고르거나 직접 답을 입력합니다. 질문이 여러 개면 차례로 답한 뒤 **답 보내기**를 누릅니다. |

카드에는 요청한 세션·프로젝트, 실행할 명령 또는 질문, 에이전트가 붙인 설명이 표시됩니다. 질문 카드가 뜨면 소리가 납니다. 승인 카드를 닫아도 요청은 메뉴에 남습니다. 질문 카드의 ✕는 원래 에이전트 화면으로 질문을 넘깁니다. 자세한 버튼 동작은 [사용 가이드](docs/GUIDE.md)에 있습니다.

메뉴바 뱃지의 `⏳ 숫자`는 대기 중인 요청 수입니다. `✓`는 연결됨, `○`는 아직 연결된 세션 없음, `⏸`는 준비 중, `⚠︎`는 Node.js를 찾지 못했다는 뜻입니다. 아이콘이 숨겨지면 **⌥⇧A**로 메뉴를 열 수 있습니다.

## 지원 범위

| 에이전트 | 승인 | 질문 |
|---|---|---|
| Claude Code | 원래 승인을 묻는 요청 | `AskUserQuestion` |
| Codex CLI | 원래 승인을 묻는 요청 | Plan 모드의 `request_user_input` |
| Codex 데스크톱 앱 | [실험적 중계](#codex-앱-연결) | 기본 모드의 비동기 질문은 원래 Codex 화면에서 답변 |

Claude Code의 자동 허용 모드나 자체 허용 목록에 있는 명령, Codex의 **나 대신 승인** 모드가 자동 처리한 요청은 카드로 오지 않습니다. Approve Here가 꺼져 있으면 에이전트의 원래 승인 화면을 사용합니다. Codex CLI 연결 조건은 [Codex 연결 안내](docs/CODEX.md)에 있습니다.

## 안 될 때

| 증상 | 확인할 것 |
|---|---|
| macOS가 앱을 차단함 | **완료**를 누르고 시스템 설정 → 개인정보 보호 및 보안 → **그래도 열기**를 선택합니다. 실행 시도 후 약 1시간 동안 보입니다. [화면별 안내](docs/GUIDE.md#2-처음-열기) |
| `⚠︎`가 보임 | [Node.js 20 이상](https://nodejs.org/)을 설치한 뒤 메뉴에서 **다시 찾기**를 누릅니다. |
| 카드가 안 뜸 | 메뉴에서 연결 상태를 확인합니다. 에이전트가 원래 승인을 묻지 않는 작업은 카드도 없습니다. Codex는 훅 신뢰가 끝났는지 확인합니다. |
| Codex CLI 질문 카드가 안 뜸 | `/plan`으로 Plan 모드를 켜고 `request_user_input` 질문인지 확인합니다. [자세한 연결 조건](docs/CODEX.md#연결-조건과-확인) |
| 메뉴바 아이콘이 안 보임 | **⌥⇧A**를 눌러 메뉴를 엽니다. 카드는 아이콘과 관계없이 표시됩니다. |
| "이미 실행 중"이라고 나옴 | 기존 앱의 메뉴에서 **종료**를 누른 뒤 새 앱을 엽니다. |

오류 원인을 더 보려면 메뉴 → **기록 폴더 열기**에서 `app.log`, `daemon.log`, `requests.jsonl`을 확인하세요.

## Codex 앱 연결

**실험적 기능 · 정식 지원 TODO.** Codex 데스크톱 앱의 실제 승인·동기 질문 카드 응답 E2E는 아직 끝나지 않았습니다. 기본 모드의 `request_user_input_async` 질문은 카드로 오지 않으므로 Codex 원래 화면에서 답하세요. 처음 쓰는 분은 검증된 Codex CLI 연결을 권합니다.

시험하려면 시작 안내에서 **Codex 앱 실행기 설치 (실험적)**를 누르고, Codex 앱을 완전히 종료한 뒤 `~/Applications/Codex with Approve Here.app`으로 다시 엽니다. 평소에는 원래 Codex 앱을 사용하세요. 중계가 필요한 이유, 설치·해제 방법과 한계는 [Codex 앱·CLI 연결 문서](docs/CODEX.md)에 있습니다.

## 데이터와 자동 승인

요청과 규칙은 이 Mac 안에 저장됩니다. Approve Here는 스스로 허용 여부를 판단하지 않습니다. **허용 + 앞으로 자동**을 누른 규칙만 기억하고, 메뉴의 **자동 승인 관리…**에서 해제할 수 있습니다. 설정이나 기록을 저장하지 못하면 실제 승인 결과와 저장 실패를 구분해 안내합니다.

기존 `PermissionRequest` 정책 훅이 있다면 `~/.approve-here/config.json`에 연결할 수 있습니다. 정책 훅이 결정하지 못한 요청만 카드로 옵니다.

```json
{ "policyHooks": { "claude": ["node /path/to/my-permission-policy.mjs"], "codex": [] } }
```

자동 승인 규칙은 `~/.approve-here/allowlist.json`, 처리 이력은 `~/.approve-here/requests.jsonl`에 있습니다. 연결·해제는 다른 에이전트 설정과 훅을 보존하며, 설정이 잘못돼 있으면 오류를 표시하고 원본을 덮어쓰지 않습니다.

## 개발

```bash
git clone https://github.com/SungHoonKim-Ski/approve-here && cd approve-here
npm ci
npm test
sh surfaces/macos/build.sh
```

앱·ZIP만 만들려면 `APPROVE_HERE_SKIP_DMG=1 sh surfaces/macos/build.sh`를 사용합니다. macOS 동작 검증 스크립트는 `surfaces/macos/test-*.sh`에 있습니다. 배포 빌드는 임시 코드 서명과 번들 검증을 통과해야 하며, 이는 Apple 배포 서명·공증을 대신하지 않습니다.

Windows·Linux와 Intel Mac용 빌드는 제공하지 않습니다. MIT 라이선스.
