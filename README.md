# lark-claude-bridge

[![version](https://img.shields.io/badge/version-2.1.1-blue)](CHANGELOG.md) [![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**Chat with Claude Code from Lark** — DM the bot or @mention it in a group chat, and Claude answers with full context continuity: it reads images, files, and voice messages, and remembers across days and weeks. **No public server, domain, or callback URL required** — events arrive over Lark's persistent WebSocket connection, so it runs on any machine with Claude Code installed.

> 中国区飞书用户请使用姊妹仓库 [feishu-claude-bridge](https://github.com/demry-max/feishu-claude-bridge)（中文文档）。Same codebase — this repo defaults to the international Lark domain (`open.larksuite.com`).

Sister projects: [feishu-claude-bridge](https://github.com/demry-max/feishu-claude-bridge) (Feishu, Chinese docs) · [dingtalk-claude-bridge](https://github.com/demry-max/dingtalk-claude-bridge) (DingTalk) · [wecom-claude-bridge](https://github.com/demry-max/wecom-claude-bridge) (WeCom)

## Features

- 🔒 **Guest isolation**: non-owners run in a separate workspace with user-level config and MCP cut off and local tools explicitly denied — they cannot reach your memory or borrow your permissions
- 🔌 **Zero public-network dependency**: events over a persistent WebSocket — deploy on a home computer
- 📲 **App created by scanning a QR code**: `npm run register` uses Lark's official app-registration OAuth flow — one scan auto-creates the app, writes credentials to `.env`, and registers you as owner
- 🧠 **Session memory**: each Lark chat maps to one Claude session (`--resume`), valid across days; `/new` to reset, `/status` to inspect
- ⏰ **Scheduled tasks (the bot schedules itself)**: say "remind me every weekday at 8" and it writes a job definition into `workspace/schedules/`; the bridge fires it on time and pushes the result proactively. Supports cron expressions and one-shot times. **The bot never gets Bash/shell access** — it only writes job definitions in a whitelisted directory; execution stays with the bridge
- ⏱️ **Activity-based timeout & task control**: the clock only runs while output stalls; `/cancel` anytime, `/redirect` to change course mid-task
- 🛡️ **Outbound redaction**: keys, tokens, JWTs and private IPs stripped before sending
- 🔊 **Voice replies**: `/voice` adds a spoken version of each answer
- 🩺 **Scheduled-task self-diagnosis**: failures are analysed automatically with a recommended action
- 🧷 **Persist memory before compaction**: nudges the bot to write durable facts into `memory/` before Claude Code auto-compacts the history
- 🔀 **Switch models on the fly**: `/model fable high` changes model and thinking effort instantly — no restart — and jobs can switch automatically on a schedule
- 📄 **Lark Docs / Bitable read & write**: built-in MCP tools (read a doc, append paragraphs, list tables/fields, read and write Bitable records) using the **bot app's own tenant permissions** — what it can touch is governed by the scopes you enable; owner-only
- 🖼️ **Send images and files back**: anything the bot writes into `workspace/outbox/` is uploaded and sent automatically (images preview inline)
- 🎫 **In-place progress card**: long-running steps update a single card instead of spamming messages, then collapse when done
- 🛂 **Access control**: `ALLOW_USERS` / `ALLOW_CHATS` allowlists (empty = unrestricted); group messages carry the sender's name
- 🖼️ **Rich message types**: text / images (Claude reads them directly) / files / voice (transcript field, with an ffmpeg + speech-API fallback) / rich posts / merged forwards / share cards
- 🔐 **Tiered permissions**: the first person to DM the bot becomes **owner** (local read-only tools + web); everyone else gets web search only and cannot touch your machine's files
- 💰 **Runs on your Claude subscription, not API keys**: headless `claude -p` reuses your local Claude Code login
- 🖥️ **macOS + Windows** (cross-spawn handles `.cmd` shims)

## 🔒 Permission boundary (since v2.0.0)

The owner and everyone else run in **two physically separate workspaces**. This is the most
important security property of the project:

| | Owner | Colleagues / group members |
|---|---|---|
| Workspace | `workspace/` (long-term memory) | `workspace-guest/` (clean, no memory imports) |
| Tools | local read-only + web + memory/skills/schedule writes + platform docs | **web search only** |
| Config sources | full (user-level settings and MCP) | project only: `--setting-sources project` + `--strict-mcp-config` |
| CLI auto-memory | on | off (that store is keyed by git repo root — shared otherwise) |
| Sessions | by chat_id | by chat_id + sender, mutually invisible |

> **Why `--allowedTools` is not enough**: it is not a sandbox. It is an allow-without-asking list and
> purely additive — `permissions.allow` from the user-level `~/.claude/settings.json` still applies to
> guest sessions. In v1.x a guest could therefore execute local CLI tools acting as the owner.
> Real containment requires cutting the config source plus an explicit `--disallowedTools` deny list
> (subtractive, beats any allow rule).

Third-party content (forwarded logs, card JSON, file names, titles) is wrapped in an untrusted-data
fence declaring it is not instructions; outbound replies are redacted before sending.

## 🗂️ Agent Workspace (OpenClaw / Hermes-style three-layer memory & skills)

The bot is more than Q&A — `workspace/` is its persistent home, with a three-layer long-term memory modeled on OpenClaw and Hermes Agent:

```
workspace/
├── CLAUDE.md          # Persona & behavior protocol (auto-loaded every call)
├── memory/
│   ├── USER.md        # Profile layer: the user's identity, preferences and style — auto-loaded every conversation
│   ├── MEMORY.md      # Facts index: one durable fact per line, injected via @import
│   ├── <slug>.md      # Facts layer: one memory = one file, Read on demand
│   └── journal/       # Journal layer: daily working notes (YYYY-MM-DD.md), retrieved via Grep, zero context cost
└── skills/            # Self-authored skills, synced by the bridge into .claude/skills
```

- **Proactive capture**: no need to say "remember" — when you correct its conclusions, make a decision, state a preference or give an authoritative number, it persists on the spot (explicit "**remember**: I fly to Manila next Wednesday" works too)
- **Supersede, never contradict**: when a fact changes it rewrites the file in place with a date; files about the same thing get merged into denser versions
- **Weekly consolidation ("dreaming")**: ask it to "set up a weekly memory-consolidation task" — it schedules a job that reads 7 days of journal, promotes durable items, merges duplicates, fixes stale entries and reports
- **Persist before compaction**: nudged automatically to write what matters into memory before the context gets auto-compacted
- Teach it a workflow and say "**save this as a skill**" → it writes `skills/<name>/SKILL.md`, auto-loaded in all later sessions; ask "**what skills do you have**" anytime
- Safety: write access is limited to `memory/`, `skills/` and similar whitelisted directories (Claude Code itself forbids agents from writing `.claude/`; the bridge syncs skills over), and the protocol forbids storing secrets in memory

## Quick Start

```bash
npm install -g @anthropic-ai/claude-code   # install/update Claude Code CLI
claude /login                              # complete browser login (subscription account)

git clone https://github.com/demry-max/lark-claude-bridge.git
cd lark-claude-bridge
npm install
npm run register   # scan the QR with the Lark app → app auto-created, .env auto-filled
npm start          # "[ws] ws client ready" in the log = connected
```

Then DM the bot in Lark — **the first person to DM it becomes the owner**. Prerequisites: Node ≥ 18; optional ffmpeg (`brew install ffmpeg` / `winget install ffmpeg`) for the voice-transcription fallback.

- Auto-start on macOS: see [examples/launchd.example.plist](examples/launchd.example.plist)
- Auto-start on Windows: `powershell -ExecutionPolicy Bypass -File scripts\windows\install-startup.ps1`
- Full step-by-step runbook (hand it to Claude Code and say "deploy per this manual"): [docs/SETUP.md](docs/SETUP.md)

### If QR registration fails (manual console setup)

Create a **custom app** at [open.larksuite.com](https://open.larksuite.com/): add the **Bot** capability; in *Permissions & Scopes* batch-import
`{"scopes":{"tenant":["im:message","im:message.p2p_msg:readonly","im:message.group_at_msg:readonly","im:resource","im:message.reactions:write","speech_to_text:speech","docx:document:readonly","docx:document","bitable:app:readonly","bitable:app","wiki:wiki:readonly","contact:user.base:readonly"],"user":[]}}`;
in *Events & Callbacks* choose **"Receive events through persistent connection"** and add `im.message.receive_v1`; then publish a version. Put the App ID / App Secret into `.env`.

## Architecture

```
Lark DM / group @bot
        │  persistent WebSocket (im.message.receive_v1)
        ▼
Bridge service (Node.js: dedupe, per-chat serial queue, owner auth, message parsing)
        │  spawn: claude -p --resume <session> --allowedTools … (prompt via stdin)
        ▼
Claude Code CLI (headless)
        ▼
Markdown card reply (plain-text fallback) + emoji receipts
```

## Security

- `.env` (App Secret) and all runtime data are git-ignored
- Non-owners have zero local file access; attachments are exposed read-only in a dedicated directory
- Claude gets read-only tools by default — never grant Write/Bash to an unattended bot

## License

[MIT](LICENSE)
