# Approve Here

여러 Claude Code·Codex 세션이 던지는 **"허용할까요?"를 한 자리에서** 처리하는 macOS 메뉴바 앱입니다.

> agent 세션을 서너 개 띄워 두면 어느 창이 승인을 기다리는지 모른다. 창을 돌며 찾고, 놓치면 그 작업은 멈춰 있다. 그리고 같은 종류의 승인을 매번 또 누른다.

승인이 필요해지면 메뉴바 뱃지가 `⏳ 1`로 바뀌고 화면 오른쪽 위에 카드가 뜹니다. **[허용] [거부]**로 답하거나 **[창으로]**를 눌러 그 요청을 낸 tmux 창으로 갑니다. 같은 종류의 승인은 "앞으로 자동"으로 기억시킵니다. Claude가 **질문**(`AskUserQuestion`)을 하면 그 카드에 옵션 버튼이 그대로 뜨고, 고르면 Claude가 다이얼로그 없이 답을 받습니다.

## 시작하기

1. [Release](https://github.com/SungHoonKim-Ski/approve-here/releases/latest)에서 **ApproveHere.dmg**를 내려받아 열고, 앱을 Applications로 끌어 넣습니다.
2. 앱을 엽니다. Apple 서명이 없어 처음 한 번은 막힐 수 있습니다 — 시스템 설정 → 개인정보 보호 및 보안 → "그래도 열기"를 누르거나, 앱을 우클릭 → 열기.
3. 메뉴바의 아이콘을 눌러 **Claude Code 연결**, **Codex 연결**을 켭니다. 쓰는 것만 켜도 됩니다.
4. 끝입니다. 승인·질문이 생기면 화면 오른쪽 위에 카드가 뜹니다.

Codex는 새 훅을 처음 만나면 **신뢰 확인**을 요구합니다. 연결을 켠 뒤 처음 `codex`를 실행하면 "Hooks need review"가 뜨는데, 검토 후 신뢰하면 됩니다.

### 어떻게 보이나

| 뱃지 | 뜻 |
|---|---|
| `⏳ 2` | 승인 요청 2건 대기. 메뉴를 열면 요청별로 허용·거부·창으로 |
| `✓` | 연결됨, 대기 없음 |
| `○` | 아직 아무 CLI도 연결하지 않음 |
| `⏸` | 대기함을 준비하는 중 (몇 초) |
| `⚠︎` | Node.js를 찾지 못함 (아래 참고) |

카드에는 요청을 낸 세션(`[claude] 프로젝트`), 명령, agent가 붙인 설명이 보이고 **[허용] [허용 + 앞으로 자동] [거부] [창으로]** 버튼이 있습니다. 질문 카드에는 옵션이 버튼으로 뜨고, 질문이 여럿이면 다 고른 뒤 **[답 보내기]**를 누릅니다. 앱에서 답하기 싫으면 **[터미널에서 답하기]**로 원래 다이얼로그를 띄웁니다. 메뉴바 메뉴에서도 같은 일을 할 수 있습니다.

### 승인 요청이 뜰 상황에서만 옵니다

- Claude Code가 `auto` 모드이거나 `permissions.allow`에 있는 명령은 원래 프롬프트가 없으니 여기로도 오지 않습니다. 시험해 보려면 `claude --permission-mode default`로 띄우고 allow 목록에 없는 명령(예: `touch x`)을 시키세요.
- Claude Code는 앱이 기다리는 동안 터미널 프롬프트도 함께 띄웁니다. 먼저 답한 쪽이 이깁니다.
- Codex는 앱이 기다리는 동안 자기 프롬프트를 숨기고 "Running hook"만 표시합니다. 앱에서 답해야 진행됩니다.
- 앱이 꺼져 있으면 아무것도 바뀌지 않습니다. 훅은 결정 없이 물러나고 CLI가 원래 프롬프트를 띄웁니다.

## 동작

```
Claude Code / Codex ── PermissionRequest 훅 ──▶ 앱 안의 코어
                                                  ├─ 1. 기억시킨 규칙(allowlist)에 맞으면 바로 허용
                                                  ├─ 2. 내 정책 훅이 있으면 먼저 실행 (있을 때만)
                                                  └─ 3. 남은 것만 메뉴바·알림으로
```

- 훅은 어떤 실패에서도 **결정 없이 물러납니다.** 앱이 없어도, Node가 없어도, 훅이 죽어도 CLI는 원래 승인 프롬프트를 띄웁니다.
- 판단은 하지 않습니다. allowlist는 당신이 "앞으로 자동"을 누른 것만 담습니다.
- 모든 것이 이 Mac 안에서 돕니다(127.0.0.1, 같은 사용자만 읽는 token 파일). 계정·클라우드가 없습니다.

## Node.js가 필요합니다

훅과 대기함 코어는 Node.js로 돕니다(앱 안에 들어 있고, Node만 시스템에 있으면 됩니다). Claude Code나 Codex CLI를 npm으로 설치했다면 이미 있습니다. 없으면 뱃지가 `⚠︎`로 뜨고 메뉴에서 내려받기 링크를 보여 줍니다.

## 고급: 내 정책 훅 연결

안전한 명령을 자동 허용하는 `PermissionRequest` 훅을 이미 쓰고 있다면 `~/.approve-here/config.json`에 적습니다. 그 훅이 결정하지 못한 것만 앱으로 옵니다.

```json
{ "policyHooks": { "claude": ["node /path/to/my-permission-policy.mjs"], "codex": [] } }
```

기억시킨 규칙은 `~/.approve-here/allowlist.json`, 모든 결정 이력은 `~/.approve-here/requests.jsonl`에 있습니다. 메뉴의 "기록 폴더 열기"로 갑니다.

## 하지 않는 것

- 질문 답변은 Claude Code만 됩니다(Codex에는 해당 도구가 없습니다). 옵션 없는 자유 입력 질문은 터미널로 넘깁니다. 이 경로는 Claude Code 문서에 없는 동작(2.1.283 실측)이라 버전이 바뀌면 막힐 수 있고, 그때는 원래 다이얼로그로 돌아갑니다.
- Apple 서명·공증이 없습니다. 첫 실행 한 번 시스템 설정에서 허용해야 하고, 그 때문에 macOS 시스템 알림은 쓰지 않습니다(카드 패널이 그 자리를 대신합니다).
- Windows·Linux는 지원하지 않습니다.

## 개발

```bash
git clone https://github.com/SungHoonKim-Ski/approve-here && cd approve-here
npm test                       # Node 코어 테스트
sh surfaces/macos/build.sh     # SwiftPM만으로 .app·zip·dmg (Xcode 불필요)
```

MIT
