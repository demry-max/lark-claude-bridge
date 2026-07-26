# Changelog

This project follows [Semantic Versioning](https://semver.org/).

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
