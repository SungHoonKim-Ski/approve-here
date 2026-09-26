# Agent Inbox

여러 Claude Code·Codex 세션이 던지는 **"허용할까요?"를 한 자리에서** 처리하는 로컬 대기함입니다.

> 매번 귀찮았던 것: agent 세션을 서너 개 띄워 두면 어느 창이 승인을 기다리는지 모른다. tmux 창을 돌며 찾고, 놓치면 그 작업은 멈춰 있다. 그리고 같은 종류의 승인을 매번 또 누른다.

Agent Inbox는 두 CLI가 공통으로 제공하는 `PermissionRequest` 훅 계약 위에서만 동작합니다. **판단은 당신의 정책이 하고**, 이 도구는 정책이 결정하지 못한 것만 받아서 당신이 있는 곳(메뉴바·tmux pane·브라우저)으로 가져오고, 결정을 다시 정책으로 돌려보냅니다.

## 어디서 왔나

[hubtwork/command-center](https://github.com/hubtwork/command-center)를 쓰는 워크스페이스에서 나왔습니다. command-center는 `.claude/hooks/permission-handler.mjs`로 안전한 명령을 자동 허용하고 나머지는 사용자 확인으로 흘려보냅니다. 그 "흘려보낸 자리"가 터미널 프롬프트였고, 병렬 세션이 늘수록 그 자리를 찾는 일이 커졌습니다. Agent Inbox는 그 자리에 섭니다 — 기존 정책 훅은 그대로 두고, 그 뒤에 붙습니다.

command-center를 쓰지 않아도 됩니다. Claude Code 또는 Codex만 있으면 모든 승인 요청이 대기함으로 옵니다.

## 동작

```
Claude Code / Codex ── PermissionRequest ──▶ hook/permission-hook.mjs
                                                │
                                                ├─ 1. allowlist (내가 "앞으로 자동"이라고 기억시킨 것)
                                                ├─ 2. 내 정책 훅들 (config.policyHooks — 예: command-center의 permission-handler.mjs)
                                                │       └─ 결정이 나면 그대로 CLI에 돌려주고 "자동 처리"로 기록만
                                                └─ 3. 데몬에 올리고 사용자 결정을 기다림
                                                        └─ 메뉴바 / tmux pane / 브라우저 중 켜 둔 곳에서 허용·거부·창으로 점프
                                                           "허용 + 앞으로 자동"을 누르면 1번 allowlist에 규칙이 쌓임
```

- 어떤 실패에서도 훅은 **결정 없이 exit 0**으로 끝납니다. 그러면 CLI가 원래 승인 프롬프트를 띄웁니다(두 CLI 공통 계약). 데몬을 안 켜 두면 아무것도 바뀌지 않습니다.
- 표면(메뉴바·pane·브라우저)이 하나도 안 떠 있으면 훅은 기다리지 않습니다. Codex는 훅이 기다리는 동안 자기 프롬프트를 숨기기 때문입니다.
- 정책 훅을 `settings.json`에 나란히 등록하지 않고 우리 훅 안에서 순서대로 실행합니다. 같은 이벤트의 훅 여럿은 병렬로 돌고 병합 순서가 정해져 있지 않아, 나란히 두면 정책이 허용한 것도 대기함이 기다리게 됩니다.

## 설치

macOS · Node 20+ · Claude Code 또는 Codex CLI.

```bash
git clone https://github.com/<you>/agent-inbox && cd agent-inbox
npm link                       # 또는 node bin/agent-inbox.mjs …
agent-inbox install --claude --codex
agent-inbox start              # 데몬 (터미널 하나에 두거나 tmux 창 하나)
```

표면은 하나 이상 켜 둡니다.

| 표면 | 실행 | 어울리는 사람 |
|---|---|---|
| macOS 메뉴바 | `sh surfaces/macos/build.sh && agent-inbox app` | 어느 앱에 있든 뱃지 ⏳ N을 보고 메뉴·알림 버튼으로 결정 |
| tmux pane | `agent-inbox tui` | command-center처럼 tmux에서 worker 창을 여럿 띄우는 사람. `g`로 그 창에 점프 |
| 브라우저 | `agent-inbox open` | 다른 기기·폰에서 보고 싶은 사람 (같은 머신 127.0.0.1 기준) |

Codex는 새 훅을 처음 만나면 **신뢰 확인**을 요구합니다. `codex`를 실행해 "Hooks need review"에서 검토·신뢰하거나 `/hooks`에서 처리하세요. 훅 명령이 바뀌면 다시 신뢰해야 합니다.

## 내 정책 훅 연결하기

`~/.agent-inbox/config.json`:

```json
{
  "policyHooks": {
    "claude": ["node /path/to/command-center/.claude/hooks/permission-handler.mjs"],
    "codex":  []
  },
  "waitSeconds": 300,
  "requireSurface": true
}
```

정책 훅은 Claude Code PermissionRequest 훅과 같은 stdin/stdout 계약이면 무엇이든 됩니다. `allow`/`deny`를 내면 그대로 CLI에 전달되고 대기함에는 "자동 처리"로만 남습니다. 아무 결정도 내지 않으면 다음 정책으로, 끝까지 없으면 대기함으로 옵니다.

`~/.agent-inbox/allowlist.json`은 "허용 + 앞으로 자동"이 쌓이는 곳입니다. 손으로 고쳐도 됩니다.

## 두 CLI의 계약 차이 (실측, 2026-09-26)

| | Claude Code 2.1.283 | Codex 0.154.0 |
|---|---|---|
| 훅 출력 스키마 | `hookSpecificOutput.decision.behavior: allow\|deny\|ask` | 같음, 단 `ask` 없음 |
| 결정 없이 종료하면 | 원래 프롬프트 | 원래 프롬프트 ("normal approval flow") |
| 훅이 기다리는 동안 | **터미널 프롬프트도 함께 뜬다** — 먼저 답한 쪽이 이김 | 프롬프트를 숨기고 "Running hook"만 표시 |
| 훅 신뢰 | 없음 | 훅 정의 hash별 신뢰 필요 |
| 발화 조건 | 프롬프트가 뜰 상황만. `settings.allow`에 있으면 안 옴. `-p` 모드 X | 같음. `codex exec`에서는 신뢰 프롬프트가 없어 프로젝트 훅이 안 뜸 |
| `TMUX_PANE` 상속 | O | O |

## 하지 않는 것

- `AskUserQuestion`(질문)에는 훅으로 답할 수 없습니다. 목록에 띄우고 창으로 점프하는 것까지가 계약의 한계입니다.
- 정책을 대신 만들어 주지 않습니다. allowlist는 당신이 "앞으로 자동"을 누른 것만 담습니다.
- 원격 접속·계정·클라우드가 없습니다. 127.0.0.1과 같은 사용자만 읽을 수 있는 token 파일이 전부입니다.

## 비슷한 도구

[PermPilot](https://github.com/Everaldtah/permpilot)(Windows, PreToolUse 훅 큐), [many-ai-cli](https://github.com/ishizakahiroshi/many-ai-cli)(PTY 래퍼 + 브라우저 허브), [Mux Beacon](https://github.com/Lukeesec/mux-beacon)(macOS 메뉴바, tmux 점프), [parley](https://github.com/AzarudeenshariffA/parley)(여러 agent 공통 allow-list). 대기함 자체는 이들과 같은 자리입니다. Agent Inbox가 다른 점은 **기존 정책 훅을 훅 프로세스 안에서 먼저 실행해 그 뒤에 서고, 결정을 다시 정책(allowlist)으로 돌려보내는 것**, 그리고 Claude Code와 Codex를 훅 계약 하나로 받는 것입니다.

## 개발

```bash
npm test                        # node --test, 25개
sh surfaces/macos/build.sh      # SwiftPM만으로 .app 번들 (Xcode 불필요)
AGENT_INBOX_HOME=/tmp/x agent-inbox start --port 4411   # 격리 실행
```

MIT
