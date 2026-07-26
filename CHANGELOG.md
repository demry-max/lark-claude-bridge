# Changelog

This project follows [Semantic Versioning](https://semver.org/).

## [1.2.0] - 2026-07-26

Capability parity pass against OpenClaw's Lark extension.

### Added
- **Lark Docs / Bitable read & write**: a built-in MCP tool server (`src/mcp-feishu.js`) exposing 7 actions —
  read a document, append paragraphs, list tables, list fields, read records, create a record, update a record.
  Uses the **bot app's own tenant credentials**, so reach is governed precisely by the scopes you enable;
  **owner-only**. Users can paste a Lark link (`/docx/`, `/base/`, `/wiki/`) directly.
- **Send images and files back**: anything written into `workspace/outbox/` is uploaded and sent after the turn,
  then cleared. Images go out as image messages with inline preview.
- **In-place progress card**: intermediate steps now update a single card instead of posting a new message each
  time, and collapse to one line when finished.
- **Access control**: `ALLOW_USERS` / `ALLOW_CHATS` allowlists; empty keeps the previous unrestricted behaviour.
- **Sender name resolution**: group messages carry the sender's name so the bot knows who is speaking
  (silently degrades without contact scope).
- **`/help`**: lists commands and capabilities.

### New scopes required
Enable and publish as needed: `docx:document:readonly`, `docx:document`, `bitable:app:readonly`, `bitable:app`,
`wiki:wiki:readonly`, `contact:user.base:readonly`.

## [1.1.0] - 2026-07-26

Everything added since the initial public release (1.0.0).

### Added
- **Scheduled tasks**: the bot schedules itself — say "remind me every weekday at 8" and it writes a job definition
  into `workspace/schedules/*.json`; the bridge fires it on time and pushes the result proactively. Supports cron
  expressions and one-shot times; newly registered cron jobs never backfill past occurrences, and one-shot jobs
  auto-disable after running. **The bot never gets Bash/shell access** — it only writes job definitions in a
  whitelisted directory.
- **Agent workspace**: `workspace/CLAUDE.md` persona protocol + `memory/` long-term memory ("remember ..." persists
  across sessions) + `skills/` self-authored skills (auto-synced into `.claude/skills` and loaded in later sessions).
- **Live progress streaming**: intermediate updates from long tasks are pushed immediately (`⏳` prefix) while the
  final answer is still delivered exactly once (stream-json parsing with de-duplication).
- **Configurable thinking effort**: `CLAUDE_EFFORT` (low/medium/high/xhigh/max).
- **`runtime.md`**: the bridge writes the real model, effort level, and current `chat_id` before every call, so the
  bot answers "which model are you on" truthfully and can fill in `chat_id` when scheduling.
- `/status` now reports model and thinking effort.

### Fixed
- **Voice transcription failed silently under the autostart service**: launchd does not inherit the shell PATH, so
  homebrew's ffmpeg (`/opt/homebrew/bin`) was unreachable. Autostart templates now include it, plus a new
  `FFMPEG_BIN` absolute-path setting.
- **Bot misreported its own model**: in headless mode a model cannot know which model it runs on and will guess;
  the bridge now supplies an authoritative `runtime.md`.
- Skip `._*` AppleDouble shadow files created on exFAT drives so they are not parsed as jobs or skills.

## [1.0.0]

Initial public release: persistent-connection setup with no public server, QR-scan app registration, rich message
types (text/images/files/voice/rich posts/forwards/cards), persistent sessions, tiered owner permissions, and
macOS launchd / Windows startup autostart.
