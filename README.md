# Approve Here

여러 Claude Code·Codex 세션이 던지는 **"허용할까요?"를 한 자리에서** 처리하는 로컬 대기함입니다.

> agent 세션을 서너 개 띄워 두면 어느 창이 승인을 기다리는지 모른다. 창을 돌며 찾고, 놓치면 그 작업은 멈춰 있다. 그리고 같은 종류의 승인을 매번 또 누른다.

Approve Here는 두 CLI가 공통으로 제공하는 `PermissionRequest` 훅 계약 위에서만 동작합니다. **판단은 당신의 정책이 하고**, 이 도구는 정책이 결정하지 못한 것만 받아서 당신이 있는 곳(tmux pane·메뉴바·브라우저)으로 가져오고, 결정을 다시 정책으로 돌려보냅니다.

## Quick Start

macOS · Node 20+ · Claude Code 또는 Codex CLI가 설치·로그인된 상태.

### 1. 설치

```bash
npm i -g approve-here
```

### 2. 훅 등록 (한 번)

```bash
approve-here install --claude --codex     # 둘 중 쓰는 것만 골라도 됩니다
```

`~/.claude/settings.json`과 `~/.codex/hooks.json`의 `PermissionRequest`에 훅 한 줄씩 들어갑니다. 다른 설정과 기존 훅은 그대로 둡니다.

**Codex는 새 훅을 처음 만나면 신뢰 확인을 요구합니다.** `codex`를 한 번 실행하면 "Hooks need review"가 뜨고, 검토 후 신뢰하면 됩니다(`/hooks`에서도 처리할 수 있습니다). 훅 명령이 바뀌면 다시 신뢰해야 합니다.

### 3. 대기함 열기

세 가지 중 하나를 켜 둡니다. **표면을 열면 데몬이 같이 뜨고**, 표면도 대기 요청도 없이 10분이 지나면 데몬이 스스로 닫힙니다. 따로 켜 둘 것이 없습니다.

```bash
approve-here          # 이 터미널(tmux pane)이 대기함이 됩니다
approve-here app      # macOS 메뉴바 — 처음 실행 시 Release에서 앱을 내려받습니다
approve-here open     # 브라우저
```

tmux pane에서는 이렇게 보입니다.

```
approve-here  2건 대기
────────────────────────────────────────────────────────────
❯ [codex] shop-be · Bash · 2s · tmux %7
    printf 'hello\n' >> README.md
    ↳ 현재 환경이 읽기 전용이므로 README.md에 쓰기 권한을 허용할까요?
  [claude] shop-fe · Bash · 9s · tmux %3
    npm run build

최근 처리
  allowed                touch probe-claude.txt
a 허용 · d 거부 · r 허용+기억 · g 창으로 · j/k 이동 · q 종료
```

### 4. 써 보기

다른 창에서 Claude Code나 Codex에게 승인이 필요한 일을 시킵니다. 카드가 뜨면:

| 키 / 버튼 | 뜻 |
|---|---|
| `a` 허용 | 이번만 허용 |
| `r` 허용 + 기억 | 허용하고, 이 명령 접두(예: `npm test`)는 앞으로 묻지 않음 → `~/.approve-here/allowlist.json`에 쌓임 |
| `d` 거부 | 거부. agent에게는 "hook이 거부했다"고 전달됨 |
| `g` 창으로 | 그 요청을 낸 tmux pane으로 이동 |

승인 요청이 **뜰 상황에서만** 옵니다. Claude Code가 `auto` 모드이거나 `settings.json`의 `permissions.allow`에 있는 명령은 원래 프롬프트가 없으니 대기함에도 오지 않습니다. 시험해 보려면 `claude --permission-mode default`로 띄우고 allow 목록에 없는 명령(예: `touch x`)을 시키세요.

### 5. 확인·되돌리기

```bash
approve-here status                       # 데몬·대기 건수·표면 유무
approve-here pending                      # 대기 목록
approve-here decide <id> allow|deny       # 터미널에서 결정
approve-here stop                         # 데몬 종료 (표면을 열면 다시 뜹니다)
approve-here uninstall --claude --codex   # 훅 제거. 데이터 폴더(~/.approve-here)는 남김
```

기록은 `~/.approve-here/requests.jsonl`, 데몬 로그는 `~/.approve-here/daemon.log`에 있습니다.

## 동작

```
Claude Code / Codex ── PermissionRequest ──▶ hook/permission-hook.mjs
                                                │
                                                ├─ 1. allowlist  — "허용 + 기억"으로 쌓인 규칙
                                                ├─ 2. 내 정책 훅들 — config.policyHooks (있으면)
                                                │       └─ allow/deny가 나오면 그대로 CLI에 돌려주고 "자동 처리"로 기록만
                                                └─ 3. 데몬에 올리고 사용자 결정을 기다림
                                                        └─ tmux pane / 메뉴바 / 브라우저 중 켜 둔 곳에서 허용·거부·창으로
```

- 어떤 실패에서도 훅은 **결정 없이 exit 0**으로 끝납니다. 그러면 CLI가 원래 승인 프롬프트를 띄웁니다(두 CLI 공통 계약). 데몬이 없어도, 표면이 없어도, 훅이 죽어도 원래 동작으로 돌아갑니다.
- 표면이 하나도 안 떠 있으면 훅은 기다리지 않습니다. Codex는 훅이 기다리는 동안 자기 프롬프트를 숨기기 때문에, 볼 사람이 없는 대기는 사용자를 막는 것과 같습니다.
- 정책 훅은 `settings.json`에 나란히 등록하지 않고 우리 훅 안에서 순서대로 실행합니다. 같은 이벤트의 훅 여럿은 병렬로 돌고 병합 순서가 정해져 있지 않아, 나란히 두면 정책이 허용한 것도 대기함이 기다리게 됩니다.

## 내 정책 훅 연결하기

이미 쓰는 `PermissionRequest` 정책 훅이 있으면(안전한 명령을 자동 허용하는 스크립트 등) `~/.approve-here/config.json`에 적습니다.

```json
{
  "policyHooks": {
    "claude": ["node /path/to/my-permission-policy.mjs"],
    "codex":  []
  }
}
```

정책 훅은 Claude Code PermissionRequest 훅과 같은 stdin/stdout 계약이면 무엇이든 됩니다. `allow`/`deny`를 내면 그대로 CLI에 전달되고 대기함에는 "자동 처리"로만 남습니다. 아무 결정도 내지 않으면 다음 정책으로, 끝까지 없으면 대기함으로 옵니다.

`~/.approve-here/allowlist.json`은 "허용 + 기억"이 쌓이는 곳입니다. 손으로 고쳐도 됩니다.

```json
[{ "tool": "Bash", "commandPrefix": "npm test", "provider": "codex" }]
```

## 설정

`~/.approve-here/config.json` (없으면 기본값). 데이터 폴더는 `APPROVE_HERE_HOME`으로 바꿉니다.

| 키 | 기본 | 뜻 |
|---|---|---|
| `port` | 4400 | 데몬 포트 (127.0.0.1에만 묶임) |
| `waitSeconds` | 300 | 훅이 사용자 결정을 기다리는 상한. 넘기면 결정 없이 끝내 원래 프롬프트로 |
| `policyHooks` | `{claude:[], codex:[]}` | provider별 정책 훅 명령 |
| `policyTimeoutSeconds` | 60 | 정책 훅 하나의 실행 시간 상한 |
| `allowlist` | true | 내장 allowlist 정책 사용 |
| `requireSurface` | true | 표면이 없으면 훅이 기다리지 않음 |
| `presenceSeconds` | 10 | 표면이 마지막으로 다녀간 뒤 이 시간 안이면 "있음" |
| `idleExitSeconds` | 600 | 표면도 대기도 없이 이 시간이 지나면 데몬 자진 종료. 0이면 안 끔 |

## 두 CLI의 계약 차이 (실측)

| | Claude Code 2.1.283 | Codex 0.154.0 |
|---|---|---|
| 훅 출력 스키마 | `hookSpecificOutput.decision.behavior: allow\|deny\|ask` | 같음, 단 `ask` 없음 |
| 결정 없이 종료하면 | 원래 프롬프트 | 원래 프롬프트 |
| 훅이 기다리는 동안 | **터미널 프롬프트도 함께 뜬다** — 먼저 답한 쪽이 이김 | 프롬프트를 숨기고 "Running hook"만 표시 |
| 훅 신뢰 | 없음 | 훅 정의 hash별 신뢰 필요 |
| 발화 조건 | 프롬프트가 뜰 상황만. `-p` 모드에서는 안 옴 | 같음. `codex exec`에서는 신뢰 프롬프트가 없어 프로젝트 훅이 안 뜸 |
| `TMUX_PANE` 상속 | O | O |

## 하지 않는 것

- `AskUserQuestion`(질문)에는 훅으로 답할 수 없습니다. 계약에 없습니다.
- 정책을 대신 만들어 주지 않습니다. allowlist는 당신이 "기억"을 누른 것만 담습니다.
- 원격 접속·계정·클라우드가 없습니다. 127.0.0.1과 같은 사용자만 읽을 수 있는 token 파일이 전부입니다.
- 메뉴바 앱은 Apple 서명·공증이 없습니다. `approve-here app`이 내려받은 경우는 그대로 열리고, 브라우저로 직접 내려받은 경우는 처음 한 번 시스템 설정 → 개인정보 보호 및 보안에서 허용해야 합니다.

## 개발

```bash
git clone https://github.com/SungHoonKim-Ski/approve-here && cd approve-here
npm test                                                  # node --test, 29개
sh surfaces/macos/build.sh                                # SwiftPM만으로 .app 번들 (Xcode 불필요)
APPROVE_HERE_HOME=/tmp/x node bin/approve-here.mjs daemon --port 4411   # 격리 실행
```

MIT
