# Lark ⇆ Claude Bot — Deployment Runbook

> **Instructions for Claude**: execute steps 0→7 in order. Fully automatic — the only human actions are the login in step 0 and the QR scan in step 5.
>
> **Result**: DM the bot in Lark (or @mention it in groups) → your local Claude Code answers (text / images / files / voice / rich posts), with persistent per-chat sessions, long-term memory, and self-authored skills. No public server needed — events arrive over Lark's persistent WebSocket. Prerequisites: macOS or Windows, Node ≥ 18; optional ffmpeg for voice fallback.

## Step 0 — Install/update Claude Code CLI and log in

```bash
npm install -g @anthropic-ai/claude-code
claude --version
```

Then run `claude /login` — a login link/QR appears in the terminal. **Present the link to the user and wait until they finish authorizing in the browser** (Claude subscription account; the bot reuses this login, no API key needed). If the machine is already logged in, just confirm with the user.

## Step 1 — Get the code

```bash
git clone https://github.com/demry-max/lark-claude-bridge.git ~/lark-claude-bridge
cd ~/lark-claude-bridge
npm install
```

(If GitHub is unreachable, recreate the files from this repo's `src/`, `scripts/`, and `workspace/` verbatim.)

## Step 2 — Write `.env`

```bash
FEISHU_DOMAIN=lark
FEISHU_APP_ID=
FEISHU_APP_SECRET=

ALLOWED_TOOLS=Read,Grep,Glob,WebSearch,WebFetch,Write(./memory/**),Edit(./memory/**),Write(./skills/**),Edit(./skills/**)
NON_OWNER_TOOLS=WebSearch,WebFetch
CLAUDE_MODEL=
CLAUDE_TIMEOUT_MS=300000
CLAUDE_EFFORT=          # 思考深度 low/medium/high/xhigh/max，留空=默认
```

`FEISHU_APP_ID` / `FEISHU_APP_SECRET` are auto-filled by step 5. Keep `FEISHU_DOMAIN=lark` for international Lark (set `feishu` for the CN edition).

## Step 3 — Verify the Claude CLI

```bash
cd ~/lark-claude-bridge/workspace && claude -p --output-format json --model haiku "Reply with exactly one word: OK"
```

Expect `result` = "OK" in the JSON. On a 401, return to step 0.

## Step 4 — (Included in repo) Agent workspace

`workspace/CLAUDE.md` and `workspace/memory/MEMORY.md` ship with the repo — they give the bot long-term memory ("remember ..." auto-persists) and self-authored skills ("save this as a skill" writes a SKILL.md that auto-loads in later sessions). Nothing to do if you cloned; if rebuilding by hand, copy both files from the repo.

## Step 5 — Register the Lark app (human action: one QR scan)

```bash
cd ~/lark-claude-bridge && npm run register
```

Show the QR/link from the terminal to the user; they scan with the Lark mobile app. On success the app is created automatically, credentials land in `.env`, and the scanner is registered as owner. If registration fails, follow "manual console setup" in the README, then fill `.env` by hand.

## Step 6 — Start and verify

```bash
cd ~/lark-claude-bridge && npm start
```

`[ws] ws client ready` in the log = connected. Have the user DM the bot "hello" in Lark — a reply completes the deployment.

## Step 7 — Run at startup

**macOS (launchd)** — write `~/Library/LaunchAgents/com.<user>.lark-claude-bridge.plist` from the template [examples/launchd.example.plist](../examples/launchd.example.plist) (absolute node path from `which node`; `PATH` must include the directory containing `claude`), then:

```bash
launchctl load -w ~/Library/LaunchAgents/com.<user>.lark-claude-bridge.plist   # install & start (stop the step-6 foreground process first)
launchctl kickstart -k gui/$(id -u)/com.<user>.lark-claude-bridge             # restart after config changes
```

**Windows** — register a login item (no admin needed):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\install-startup.ps1
```

---

## Appendix — Usage & troubleshooting

| Topic | Notes |
|-------|-------|
| Usage | DM = chat; groups reply only when @mentioned; images/files/voice supported; `/new` resets the session; `/status` shows session info |
| Permissions | First DM sender = owner (local read-only tools + web + memory/skills writes); everyone else gets WebSearch/WebFetch only; tune via `.env` |
| Memory/skills | "remember ..." → `workspace/memory/`; "save this as a skill" → `workspace/skills/`; new memories apply to new sessions (`/new`) |
| No replies | Check the log (macOS `~/Library/Logs/lark-claude-bridge.log` / Windows `bridge.log`); confirm `ws client ready`; confirm the app is published with persistent-connection events |
| "Login expired" reply | Run `claude /login` on the host; permanent fix: `claude setup-token` and put the token in `.env` as `CLAUDE_CODE_OAUTH_TOKEN=` |
| Image/voice permission errors | Open the missing scopes in the developer console (see README manual-setup JSON) and publish a new version |
| Machine off/asleep | The bot is offline (physical limitation); for 24×7, deploy on an always-on host |
| Safety | Never commit or share `.env`; never grant Write/Bash to an unattended bot; never use `--dangerously-skip-permissions` |
