# Changelog

This project follows [Semantic Versioning](https://semver.org/).

## [1.6.0] - 2026-08-13

### Added
- **Three-layer memory architecture (modeled on OpenClaw / Hermes Agent)**: `memory/` splits into a profile layer (`USER.md` — the user's identity, preferences and style, auto-loaded every conversation), a facts layer (one fact per file + `MEMORY.md` index) and a journal layer (`journal/YYYY-MM-DD.md` daily working notes, retrieved via Grep at zero context cost).
- **Proactive capture rules**: the bot persists memories without being told "remember" — corrections to its assumptions, decisions, preferences, authoritative numbers and deadline commitments are written on the spot; plus an explicit skip-list, a supersede rule (rewrite in place, never contradict) and a Grep-before-answering rule for questions about the past.
- **Weekly consolidation ("dreaming")**: ask the bot to set up a weekly scheduled task that reads the last 7 days of journal, promotes durable items, merges duplicates, fixes stale entries and reports the changes.
- The pre-compaction nudge (v1.5.0) now speaks the layered dialect: profile → USER.md, durable facts → own file + index, process details → journal.

### Changed
- `workspace/CLAUDE.md` memory protocol rewritten; added `workspace/memory/USER.md` skeleton and `memory/journal/` directory.

## [1.5.0] - 2026-08-13

### Added
- **Persist memories before context compaction**: the bridge tracks how much context each turn feeds in and, once it
  crosses `CONTEXT_NUDGE_TOKENS` (default 850k, `0` disables), injects a one-time reminder into the **next** prompt so
  the bot writes durable facts/decisions/preferences from that stretch of conversation into `memory/` and updates the
  index. Owner-only (only the owner can write memory), fires exactly once (consumed on read), and explicitly instructs
  the bot not to change its tone because of it.
- **`/status` shows context usage**: current context size and the reminder threshold, so you can see how far the
  session is from compaction.

### Background
Claude Code auto-compacts conversation history near the context limit (observed on one session at 1,001,111 tokens —
earlier turns replaced by a summary). Compaction does **not** touch `memory/` files, which live on disk and are
re-read every call — but it also does **not** write anything into memory, so details that only lived in the
conversation are lost. This closes that gap.

## [1.4.0] - 2026-08-10

### Added
- **`/model` command**: inspect or switch model and thinking effort from chat — `/model fable high`,
  `/model opus xhigh`, or `/model high` (effort only). **Takes effect immediately, no restart**, and is written
  back to `.env` so it survives restarts. Owner-only, with whitelist validation for both values.
- **Scheduled model switching**: jobs now support `"action": "set-model"` with `model` / `effort` fields, so you
  can drop to a cheaper tier on a cron or at a one-off time.

### Fixed
- **Model config previously required a restart**: `CLAUDE_MODEL` / `CLAUDE_EFFORT` moved from load-time constants
  to runtime variables.
- **Dropped the external scheduling script**: switching config via a macOS launchd shell script fails silently on
  external (exFAT) volumes — the system blocks it at the TCC layer with `Operation not permitted`. The bridge's own
  scheduler now performs the switch, with no launchd dependency.

## [1.3.1] - 2026-07-31

### Fixed
- **Stale upgrade config silently killed long tasks**: v1.3.0 changed `CLAUDE_TIMEOUT_MS` from a hard timeout to an
  absolute cap, but the `300000` (5 min) commonly left in older `.env` files made the cap shorter than the idle
  timeout, so long tasks were always killed. Startup now self-checks: if the absolute cap is below the idle timeout,
  it logs a clear warning and raises it automatically.
  **Upgrade note**: set `CLAUDE_TIMEOUT_MS=3600000` and add `CLAUDE_IDLE_TIMEOUT_MS=600000` in `.env`.

## [1.3.0] - 2026-07-26

Capabilities learned from similar GitHub projects (ofoxai/lark-claude-bot, Kirafy123/feishu-claude-bot, yangwhale/CloseCrab).

### Added
- **Activity-based timeout**: the clock only runs while Claude is silent — a task is killed after
  `CLAUDE_IDLE_TIMEOUT_MS` (default 10 min) of no output, with `CLAUDE_TIMEOUT_MS` (default 60 min) as a hard cap.
  Previously a flat 5-minute timeout killed legitimate long tasks.
- **`/cancel`**: abort the running task and unblock the chat queue.
- **`/redirect <new instruction>`**: interrupt the current task and restart with new instructions, context preserved.
- **Busy notice**: messages arriving mid-task now suggest `/cancel` or `/redirect` instead of silently queueing.
- **Outbound redaction**: API keys, tokens, JWTs, `Bearer`/`password` literals and private IPs are stripped from
  every outgoing message; runtime credentials (App Secret, etc.) are filtered too.
- **Structured progress**: the progress card marks each step ✅/🔄 and turns fully ✅ on completion.
- **Scheduled-task self-diagnosis**: a failed job triggers a diagnostic pass (failure class, root cause,
  recommended action) delivered alongside the error.
- **`/voice`**: replies additionally come as a voice message (macOS `say` + ffmpeg/libopus).
- **Sheets tools**: MCP gains `sheet_read` / `sheet_write` (9 tools total).

### Note
- Mail tools were not added: the enterprise mailbox API requires user-level authorization, which conflicts with
  this project's "app tenant credentials only" security model.

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
