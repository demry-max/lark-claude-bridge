# lark-claude-bridge

[![version](https://img.shields.io/badge/version-1.3.1-blue)](CHANGELOG.md) [![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**Chat with Claude Code from Lark** — DM the bot or @mention it in a group chat, and Claude answers with full context continuity: it reads images, files, and voice messages, and remembers across days and weeks. **No public server, domain, or callback URL required** — events arrive over Lark's persistent WebSocket connection, so it runs on any machine with Claude Code installed.

> 中国区飞书用户请使用姊妹仓库 [feishu-claude-bridge](https://github.com/demry-max/feishu-claude-bridge)（中文文档）。Same codebase — this repo defaults to the international Lark domain (`open.larksuite.com`).

Sister projects: [feishu-claude-bridge](https://github.com/demry-max/feishu-claude-bridge) (Feishu, Chinese docs) · [dingtalk-claude-bridge](https://github.com/demry-max/dingtalk-claude-bridge) (DingTalk) · [wecom-claude-bridge](https://github.com/demry-max/wecom-claude-bridge) (WeCom)

## Features

- 🔌 **Zero public-network dependency**: events over a persistent WebSocket — deploy on a home computer
- 📲 **App created by scanning a QR code**: `npm run register` uses Lark's official app-registration OAuth flow — one scan auto-creates the app, writes credentials to `.env`, and registers you as owner
- 🧠 **Session memory**: each Lark chat maps to one Claude session (`--resume`), valid across days; `/new` to reset, `/status` to inspect
- ⏰ **Scheduled tasks (the bot schedules itself)**: say "remind me every weekday at 8" and it writes a job definition into `workspace/schedules/`; the bridge fires it on time and pushes the result proactively. Supports cron expressions and one-shot times. **The bot never gets Bash/shell access** — it only writes job definitions in a whitelisted directory; execution stays with the bridge
- ⏱️ **Activity-based timeout & task control**: the clock only runs while output stalls; `/cancel` anytime, `/redirect` to change course mid-task
- 🛡️ **Outbound redaction**: keys, tokens, JWTs and private IPs stripped before sending
- 🔊 **Voice replies**: `/voice` adds a spoken version of each answer
- 🩺 **Scheduled-task self-diagnosis**: failures are analysed automatically with a recommended action
- 📄 **Lark Docs / Bitable read & write**: built-in MCP tools (read a doc, append paragraphs, list tables/fields, read and write Bitable records) using the **bot app's own tenant permissions** — what it can touch is governed by the scopes you enable; owner-only
- 🖼️ **Send images and files back**: anything the bot writes into `workspace/outbox/` is uploaded and sent automatically (images preview inline)
- 🎫 **In-place progress card**: long-running steps update a single card instead of spamming messages, then collapse when done
- 🛂 **Access control**: `ALLOW_USERS` / `ALLOW_CHATS` allowlists (empty = unrestricted); group messages carry the sender's name
- 🖼️ **Rich message types**: text / images (Claude reads them directly) / files / voice (transcript field, with an ffmpeg + speech-API fallback) / rich posts / merged forwards / share cards
- 🔐 **Tiered permissions**: the first person to DM the bot becomes **owner** (local read-only tools + web); everyone else gets web search only and cannot touch your machine's files
- 💰 **Runs on your Claude subscription, not API keys**: headless `claude -p` reuses your local Claude Code login
- 🖥️ **macOS + Windows** (cross-spawn handles `.cmd` shims)

## 🗂️ Agent Workspace (Hermes-style memory & skills)

The bot is more than Q&A — `workspace/` is its persistent home:

```
workspace/
├── CLAUDE.md          # Persona & protocols (auto-loaded on every call)
├── memory/            # Long-term memory: one fact = one md file
│   └── MEMORY.md      # Index, injected on every conversation via @import
└── skills/            # Self-authored skills, synced into .claude/skills
```

- Tell it "**remember**: I fly to Manila next Wednesday" → written to `memory/`, effective across all future sessions and chats
- Teach it a workflow and say "**save this as a skill**" → it writes `skills/<name>/SKILL.md`, auto-loaded in every later session
- Ask "**what skills do you have**" → it lists them
- Safety: write access is limited to `memory/` and `skills/` only (Claude Code itself forbids agents from writing `.claude/`; the bridge syncs skills over), and the protocol forbids storing secrets in memory

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
