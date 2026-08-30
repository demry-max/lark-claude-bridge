# Changelog

This project follows [Semantic Versioning](https://semver.org/).

## [2.0.2] - 2026-08-30

Clears the remaining medium/low findings from the acceptance review. No breaking changes.

### Hardening

- **Hard floor on guest tools**: `Bash`/`Write`/`SendMessage`/`Artifact`/`Workflow` and friends are
  now denied in code. The `GUEST_TOOLS` env var can only **add** other tools to the allowlist, never
  unlock these (previously a mis-set env could widen the restriction entirely).
- **Guest system prompt no longer carries owner-side concepts** (outbox, scheduling, chat_id) — a
  guest has none of those capabilities, and describing them only invites attempts.

### Fixed

- Progress-card sends now form a real serial chain. The previous version awaited a snapshot of the
  in-flight request, so with three concurrent flushes the third still raced the second and created
  duplicate cards.
- `/redirect` and `/new` now also abort a retry that is waiting in backoff (previously only
  `cancelRun` was called, so during backoff the old request still ran to completion first).
- The chat failure path also flushes that turn's outbox, so files written during a failed turn are
  no longer attached to the next successful answer.
- State paths now use `DATA_DIR` exported from `store.js`: with a custom `WORKSPACE_DIR` the derived
  directory could be missing, writes were silently swallowed, and startup-notice dedup never worked.
- Exit damping is now an **escalating backoff that persists across restarts** (15s→1m→5m→15m, reset
  after 5 minutes of stable running), and the launchd example's `ThrottleInterval` went from 10 to 60.
- `/tasks` lists jobs correctly before any state file exists instead of erroring out.
- Bare-date one-shot jobs (`2026-09-01`) parse at local midnight instead of being read as UTC.
- Files left in the v1.x `outbox/` root are collected into `outbox/_legacy/` at startup — after the
  upgrade they could neither be sent nor cleaned and would simply sit there.

### Docs

- Added `.env.example` covering every switch, grouped and annotated with defaults and the
  consequence of leaving each blank.
- README corrected: since v2.0.0 the first person to DM the bot no longer becomes owner by default;
  manual installs must set `OWNER_OPEN_ID` in `.env`.

## [2.0.1] - 2026-08-30

### Security (important — upgrade from 2.0.0)

Post-release acceptance testing found that v2.0.0's guest restrictions rested on a **blocklist**
(`--disallowedTools`), which only blocks the names you listed. Measured: a guest still held
**22 built-in tools**, including `SendMessage`, `Artifact`, `CronCreate`, `Workflow` and
`ListAgents`. Worse, the guest process runs under the **owner's own Claude account**, so a
non-owner could publish Artifacts and create cron jobs as the owner — and even **inject messages
into the owner's running privileged sessions**, which hold full Bash/write access.

- **Switched to an allowlist**: guests now use `--tools`, so only the explicitly listed built-ins
  exist at all. Measured tool count dropped from 22 to 1 (`WebSearch`). This is also future-proof:
  new built-ins shipped by the CLI will not silently become guest-reachable. The blocklist remains
  as defence in depth.
- **WebFetch removed from guests by default**: it does not restrict destinations — verified that
  `http://127.0.0.1:3000` really connects, with the error revealing port reachability — and it can
  exfiltrate data through the URL. Opt in with `GUEST_TOOLS=WebSearch,WebFetch` if needed.
- **Guests load no settings files** (`--setting-sources ''`): user-level `permissions.allow` caused
  the 2.0.0 CRITICAL, and a project-level file can just as easily be committed with an allow rule.

### Notes

Guests still get a temporary `Read` when they send an attachment, scoped to their own workspace by
`Read(./incoming/**)`. Owner capabilities are unchanged.

## [2.0.0] - 2026-08-30

> This release fixes a **critical security flaw**. If you expose the bot to anyone besides the
> owner (colleague DMs, group chats), upgrade immediately.

### Security (important)

- **Guests can no longer borrow the owner's permissions to run tools.** Non-owners were limited
  with `--allowedTools` alone, but that is not a sandbox — it is an allow-without-asking list and
  purely additive; `permissions.allow` in the user-level `~/.claude/settings.json` still applies to
  guest sessions. In testing, a guest could execute local CLI tools acting as the owner. Guests now
  run with `--setting-sources project` + `--strict-mcp-config` + an explicit `--disallowedTools`
  deny list (subtractive, beats any allow rule).
- **Guest and owner workspaces are physically separated**: non-owners run in a new
  `workspace-guest/` whose CLAUDE.md contains no `@memory/` imports. Previously everyone shared the
  owner workspace, so the profile and memory index were injected into every conversation — locking
  down tools does not lock down context.
- **Guests run with CLI auto-memory disabled** (`autoMemoryEnabled: false`). That store is keyed by
  git repo root, which owner and guest share — leaving it on means one shared memory (a leak one
  way, persistent prompt injection the other).
- **Session keys are scoped by identity**: in a group, owner and guests share a `chat_id`; sharing
  the session let a guest `--resume` straight into the owner's memory-bearing conversation. Guest
  keys are further scoped per sender, so guests neither read each other's history nor plant
  long-lived instructions in a shared session.
- **Third-party content is fenced**: forwarded chat logs, card JSON, file names and message titles
  are wrapped and declared "not instructions", with a CSPRNG nonce and forged closing markers stripped.
- **Owner claim tightened**: `ALLOW_USERS` (who may use the bot) is decoupled from claim eligibility;
  new `OWNER_OPEN_ID` is the authoritative source. A missing record no longer auto-claims unless
  `ALLOW_OWNER_CLAIM=true`. A failed `saveOwner` no longer reports success.
- Scheduled-task `action` values are whitelisted; unknown actions are refused.

### Fixed

- **`/redirect` had never worked since v1.3.0**: a declaration-order bug caused a TDZ crash — and it
  crashed *after* cancelling the running task, so the old task died, the new instruction never ran,
  and the user saw nothing at all.
- **Permanently deaf after the WebSocket gave up**: once the reconnect budget ran out the process
  stayed alive and the supervisor saw nothing wrong. It now exits for the supervisor to restart,
  with backoff (no restart storms) and a ping watchdog.
- **Shared outbox delivered files to the wrong chat**: files written by scheduled jobs lingered and
  were sent along with the next unrelated message. Now isolated per session, and flushed on both the
  success and failure paths of scheduled jobs.
- **Retry replayed tasks that had already caused side effects**: retries are now limited to failures
  that occurred before any output. `502|503|529` gained word boundaries so numbers in prose no longer
  match.
- **Scheduled-job sessions were resumed forever**: the `sched:` pseudo-session blocked writes but not
  reads, so weeks of reports accumulated in one context.
- **Context-usage metric was wrong**: cumulative per-turn usage was treated as resident context,
  inflating the number several-fold and firing the nudge early.
- Scheduler: locking moved from the whole tick to the individual job (a long job no longer starves
  its peers past the catch-up window), per-key state writes, late jobs skipped, cron macros like
  `@daily` no longer mistaken for one-shot timestamps, rescheduling no longer back-fires once, and
  state distinguishes done/skipped/failed.
- Progress cards: throttled, capped, in-flight requests serialised (no duplicate cards), and closed
  out on cancel/failure instead of sitting at "processing" forever.
- `/cancel` now works during the retry backoff window instead of claiming nothing is running.
- `.env` and all state files are written atomically (a truncated `.env` made startup fail and the
  supervisor loop forever).
- Process-level `uncaughtException`/`unhandledRejection` handling; `stdin` EPIPE and state-write
  failures no longer kill the process.
- `/voice on` no longer turns voice *off* when it was already on.
- `/new` is no longer silently undone by a finishing task writing the old session back.

### Added

- **Automatic memory recall**: each message triggers a keyword search over `memory/` (journal
  included) and the likely-relevant files are surfaced to the model. Previously recall depended on
  the model remembering to grep — it wrote diligently but often failed to look.
- **`/tasks`**: last/next fire time and status for every scheduled job.
- **Startup notice**: the owner is told when the bridge restarts (deduped within 30 minutes), so a
  dead process is no longer silent.
- **Silence when there is nothing to report**: a job returning `HEARTBEAT_OK` is skipped, making
  watchdog-style jobs practical.
- **Per-job model**: scheduled jobs may set `model`/`effort` (cheap model for routine checks).
- **Attachment TTL**: `incoming/` is cleaned periodically (24MB had accumulated in practice).
- **Regression tests** (`npm test`, no extra dependencies): behaviour-based, and mutation-tested —
  reverting a fix turns them red.

### Breaking changes

- `workspace/runtime.md` is gone: runtime configuration is injected into the system prompt per call
  (the shared file was overwritten by concurrent runs, so the model could read someone else's chat_id).
- The file-return directory moved from `outbox/` to `outbox/<per-run>/`, communicated via the system
  prompt; files written to the root are no longer sent.
- `schedule-state.json` entries changed from a string to `{at, when, status}` (old format still read).

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
