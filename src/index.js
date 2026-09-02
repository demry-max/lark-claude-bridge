import 'dotenv/config';
import * as lark from '@larksuiteoapi/node-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { runClaude, checkCliEnvironment, resetSession, abortRetries, sessionKeysWithPrefix, runningKeysWithPrefix, sessionInfo, WORKSPACE_DIR, GUEST_WORKSPACE_DIR, workspaceFor, outboxDirFor, cancelRun, isRunning, getRuntimeConfig, setRuntimeConfig, MODEL_ALIASES, EFFORT_LEVELS, consumeMemoryNudge, shouldRecycleSession } from './claude.js';
import { buildPrompt, cleanIncoming, describeError } from './messages.js';
import { loadOwner, saveOwner } from './store.js';
import { startScheduler } from './scheduler.js';
import { CronExpressionParser } from 'cron-parser';
import { createProgressChannel, flushOutbox, resolveSenderName, redact, sendVoice } from './outbound.js';
import { recallHint } from './memory-recall.js';

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;

if (!APP_ID || !APP_SECRET) {
  console.error('Missing FEISHU_APP_ID / FEISHU_APP_SECRET — check your .env');
  process.exit(1);
}

// FEISHU_DOMAIN=lark connects to international Lark (open.larksuite.com)
const DOMAIN = process.env.FEISHU_DOMAIN === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu;

const client = new lark.Client({ appId: APP_ID, appSecret: APP_SECRET, domain: DOMAIN });

// Terminal state of the persistent connection: once the SDK exhausts its reconnect budget
// (or hits a non-retryable error code) it gives up for good. The process is still alive, the
// scheduler keeps ticking and launchd believes everything is fine — but the bot has gone
// permanently deaf to every message. The only reliable signal is to exit on purpose and let
// launchd's KeepAlive bring us back; reconnecting restores service.
const wsClient = new lark.WSClient({
  appId: APP_ID,
  appSecret: APP_SECRET,
  domain: DOMAIN,
  loggerLevel: lark.LoggerLevel.info,
  wsConfig: { pingTimeout: Number(process.env.WS_PING_TIMEOUT_SEC) > 0 ? Number(process.env.WS_PING_TIMEOUT_SEC) : 30 },
  onError: (e) => {
    // Damp it by 15 seconds: on a persistent fault this must not turn into a high-frequency
    // restart storm together with launchd
    bailOut(`connection entered a terminal state, exiting so launchd can restart it: ${e?.message ?? e}`, 15_000);
  },
  onReconnecting: (n) => console.log(`[ws] reconnecting (attempt ${n ?? '?'})`),
  onReconnected: () => console.log('[ws] reconnected'),
});

// Watchdog: if this SDK build never fires onError (version differences), still self-heal
setInterval(() => {
  try {
    const st = wsClient.getConnectionStatus?.();
    const state = typeof st === 'string' ? st : st?.state; // the SDK returns an object — comparing it to a string outright was dead code
    if (state === 'failed') {
      bailOut(`watchdog saw connection status=${state}, exiting so launchd can restart it`, 15_000);
    }
  } catch { /* this SDK build has no such method — ignore */ }
}, 60_000).unref();

// Give any running child process a moment to wind down before exiting, and damp back-to-back
// restarts: a bare exit(1) with launchd's ThrottleInterval=10 means 8640 restarts a day on a
// persistent fault, plus 8640 push notifications — worse than the silent deafness it replaced.
let exiting = false;
function bailOut(reason, delayMs = 0) {
  if (exiting) return;
  exiting = true;
  console.error(`[exit] ${reason}`);
  setTimeout(() => process.exit(1), delayMs).unref();
}

// Process-level safety net: better to restart than to keep limping along in silence
// (anything thrown inside an event callback lands straight on uncaughtException)
process.on('uncaughtException', (e) => {
  console.error('[fatal] uncaughtException:', e?.stack ?? e);
  bailOut('uncaughtException', 2000);
});
process.on('unhandledRejection', (e) => {
  console.error('[fatal] unhandledRejection:', e?.stack ?? e);
});

// ---- Access control: empty = original behaviour (anyone may DM); once set, only listed IDs ----
const parseList = (v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const ALLOW_USERS = parseList(process.env.ALLOW_USERS); // open_id allowlist
const ALLOW_CHATS = parseList(process.env.ALLOW_CHATS); // chat_id allowlist (groups)
// The authoritative source for the owner's identity: set it and the owner survives a lost or
// corrupted owner.json, with no claiming flow needed
const OWNER_OPEN_ID = (process.env.OWNER_OPEN_ID ?? '').trim();
const voiceChats = new Set(); // chats with voice replies switched on

function isAllowed(openId, chatId, isP2p) {
  if (isP2p) return ALLOW_USERS.length === 0 || ALLOW_USERS.includes(openId);
  if (ALLOW_CHATS.length && !ALLOW_CHATS.includes(chatId)) return false;
  return ALLOW_USERS.length === 0 || ALLOW_USERS.includes(openId);
}

const HELP_TEXT = [
  '**Commands**',
  '- `/new` start a brand-new session (forget everything before it)',
  '- `/status` show session, model, thinking effort and allowed tools',
  '- `/help` show this message',
  '- `/cancel` stop the task that is currently running',
  '- `/redirect <new instruction>` stop the current task and start over with new instructions',
  '- `/voice` toggle voice replies (each answer comes with an audio clip)',
  '- `/model [model] [effort]` show or switch model, e.g. `/model fable high` (owner only)',
  '- `/tasks` list scheduled tasks with their last and next run (owner only)',
  '',
  '**What I can do**',
  '- Just talk to me; in a group, @ me',
  '- Send images / files / voice notes and I will read them before answering',
  '- Say "remember ..." and I will write it to long-term memory, kept across sessions',
  '- Say "save this as a skill" and I will turn the workflow into a skill I follow from then on',
  '- Say "remind me every day at 8" and I will schedule the task myself',
].join('\n');

// ---- Message dedupe (Lark may redeliver events) ----
const seen = new Set();
function isDuplicate(messageId) {
  if (seen.has(messageId)) return true;
  seen.add(messageId);
  if (seen.size > 1000) {
    for (const id of seen) {
      seen.delete(id);
      if (seen.size <= 500) break;
    }
  }
  return false;
}

// ---- One queue per chat, so concurrent --resume calls cannot collide ----
const chatQueues = new Map();
function enqueue(chatId, task) {
  const prev = chatQueues.get(chatId) ?? Promise.resolve();
  const next = prev.then(task).catch((e) => console.error('[queue]', e));
  chatQueues.set(chatId, next);
  return next;
}

async function reply(messageId, text) {
  const safe = redact(text);
  const chunks = [];
  for (let i = 0; i < safe.length; i += 20000) chunks.push(safe.slice(i, i + 20000));
  for (const chunk of chunks) {
    try {
      await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'interactive',
          content: JSON.stringify({
            config: { wide_screen_mode: true },
            elements: [{ tag: 'markdown', content: chunk }],
          }),
        },
      });
    } catch (e) {
      // fall back to plain text when the markdown card fails
      console.error('[reply] card failed, fallback to text:', e?.message ?? e);
      await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: { msg_type: 'text', content: JSON.stringify({ text: chunk }) },
      });
    }
  }
}

async function react(messageId, emoji) {
  try {
    await client.im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emoji } },
    });
  } catch {
    // silently skip when the reaction scope is not granted
  }
}

// ---- The bot's own open_id (used to detect @mentions in groups) ----
let botOpenId = null;
async function getBotOpenId() {
  if (botOpenId) return botOpenId;
  try {
    const res = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' });
    botOpenId = res?.bot?.open_id ?? null;
    if (botOpenId) console.log(`[bot] open_id = ${botOpenId}`);
  } catch (e) {
    console.error('[bot] failed to fetch bot info:', e?.message ?? e);
  }
  return botOpenId;
}

async function handleMessage(data) {
  const message = data.message;
  const senderOpenId = data.sender?.sender_id?.open_id;
  if (!message || !senderOpenId) return;
  if (isDuplicate(message.message_id)) return;

  // In groups, only respond when the bot is @mentioned
  if (message.chat_type !== 'p2p') {
    const bot = await getBotOpenId();
    const mentioned = (message.mentions ?? []).some(
      (m) => m?.id?.open_id && m.id.open_id === bot
    );
    if (!mentioned) return;
  }

  if (!isAllowed(senderOpenId, message.chat_id, message.chat_type === 'p2p')) {
    console.log(`[deny] ${senderOpenId} @ ${message.chat_id} is not on the allowlist`);
    return;
  }

  // ---- Owner: the first person to DM claims the bot; the owner gets local tools, everyone else web only ----
  let owner = OWNER_OPEN_ID || loadOwner();
  if (!owner && message.chat_type === 'p2p') {
    // Tightened auto-claim: if owner.json ever goes missing (disk failure, accidental delete,
    // restore from an old backup), the next person to DM the bot would inherit every local tool
    // and all of the private memory. With ALLOW_USERS set we only accept people on that list;
    // without it, claiming has to be enabled explicitly, once.
    // ALLOW_USERS answers "who may use this bot", not "who is entitled to be its owner" —
    // conflating the two lets any listed colleague silently inherit every permission the moment
    // owner.json goes missing
    if (ALLOW_USERS.length && !ALLOW_USERS.includes(senderOpenId)) {
      console.error(`[owner] refusing to claim: ${senderOpenId} is not in ALLOW_USERS`);
      await reply(message.message_id, 'This bot has not finished its setup yet. Please contact the administrator.');
      return;
    }
    // Reaching here means OWNER_OPEN_ID is unset (when set, owner is always truthy)
    if (process.env.ALLOW_OWNER_CLAIM !== 'true') {
      console.error(
        `[owner] owner.json is missing and claiming is not enabled. If a re-claim really is intended, set ALLOW_OWNER_CLAIM=true in .env and restart; ` +
          `the safer fix is to put the owner's open_id in ALLOW_USERS. Requested by: ${senderOpenId}`
      );
      await reply(message.message_id, '⚠️ The owner record is missing, so nobody was claimed automatically. Restore `data/owner.json` on the host, or configure the bot as described in the log, then restart.');
      return;
    }
    owner = senderOpenId;
    if (!saveOwner(owner)) {
      // Answering "you are registered" after the write failed would demote the real owner to a
      // guest on every message from then on
      await reply(message.message_id, '⚠️ The owner record could not be written (disk not writable), so nothing was registered. Check the host disk and try again.');
      return;
    }
    console.log(`[owner] locked owner open_id = ${owner}`);
    await reply(
      message.message_id,
      `✅ You are now registered as this bot's owner (open_id: \`${owner}\`).\nJust send a message to start chatting; send **/new** for a fresh session, **/status** to inspect it.`
    );
    return;
  }
  const isOwner = senderOpenId === owner;

  // The session key must distinguish identities: in a group the owner and a guest share one
  // chat_id, but their cwd now differs (workspace vs workspace-guest). Sharing one session would
  // let a guest --resume straight back into the owner's history with its private memory — the
  // workspace isolation would be bypassed entirely.
  const sessionKey = isOwner
    ? message.chat_id
    // Then split it further per speaker: guest A's history has no business in guest B's context
    // inside the same group, and it stops any one guest from planting standing instructions in a
    // shared session
    : `guest:${message.chat_id}:${senderOpenId}`;

  // ---- Message → prompt (text / image / file / rich post / merged forward / card) ----
  // Attachments land in the sender's own workspace: a guest's files have no business in the
  // owner's workspace, and vice versa
  const myWorkspace = workspaceFor(isOwner);
  let built;
  try {
    built = await buildPrompt(client, message, myWorkspace, senderOpenId);
  } catch (e) {
    console.error('[buildPrompt]', e);
    // Do not blame every failure on permissions: the SDK's AxiosError often has an empty
    // message, so the old text rendered as blank space plus a misleading permissions hint
    const d = describeError(e);
    await reply(
      message.message_id,
      `⚠️ Could not process this message: ${d.text}${d.hint ? `\n${d.hint}` : ''}`
    );
    return;
  }
  if (built.unsupported) {
    await reply(message.message_id, built.unsupported);
    return;
  }
  const text = built.prompt?.trim();
  if (!text) return;

  // ---- Built-in commands ----
  // Session-lifecycle commands affect the whole session (which everyone shares in a group), so
  // they are owner-only there — otherwise any member could kill the task the owner is running,
  // or wipe the group's conversation context
  const LIFECYCLE_CMDS = ['/new', '/cancel', 'cancel', '/voice', '/voice on', '/voice off', '/tasks'];
  const isLifecycle = LIFECYCLE_CMDS.includes(text) || text.startsWith('/redirect');
  if (isLifecycle && !isOwner && message.chat_type !== 'p2p') {
    await reply(message.message_id, 'Only the owner can use session controls in a group chat (DM me if you need them).');
    return;
  }

  if (text === '/new') {
    resetSession(sessionKey);
    if (isRunning(sessionKey)) cancelRun(sessionKey); // otherwise the old task writes the session back as it finishes
    // In a group, the owner's /new also clears the guests' shared sessions (guests cannot reset
    // anything in a group themselves)
    if (isOwner && message.chat_type !== 'p2p') {
      for (const k of sessionKeysWithPrefix(`guest:${message.chat_id}:`)) {
        resetSession(k);
        if (isRunning(k)) cancelRun(k);
      }
    }
    await reply(message.message_id, '🆕 Reset done. The next message starts a brand-new Claude session.');
    return;
  }
  if (text === '/tasks') {
    if (!isOwner) {
      await reply(message.message_id, 'Only the owner can view scheduled tasks.');
      return;
    }
    await reply(message.message_id, describeTasks());
    return;
  }
  if (text === '/status') {
    await reply(message.message_id, sessionInfo(sessionKey, isOwner));
    return;
  }
  if (text === '/help' || text === 'help') {
    await reply(message.message_id, HELP_TEXT);
    return;
  }
  if (text === '/model' || text.startsWith('/model ')) {
    if (!isOwner) {
      await reply(message.message_id, 'Only the owner can switch models.');
      return;
    }
    const args = text.slice('/model'.length).trim().split(/\s+/).filter(Boolean);
    const cur = getRuntimeConfig();
    if (!args.length) {
      await reply(
        message.message_id,
        [
          `**Current model**: \`${cur.model || '(CLI default)'}\``,
          `**Thinking effort**: \`${cur.effort || '(CLI default)'}\``,
          '',
          `Usage: \`/model <model> [effort]\`, for example \`/model fable high\``,
          `Aliases: ${Object.keys(MODEL_ALIASES).join(' / ')} (a full model name works too)`,
          `Effort levels: ${EFFORT_LEVELS.join(' / ')}`,
        ].join('\n')
      );
      return;
    }
    try {
      // If the first argument is an effort level, only change the effort
      const first = args[0].toLowerCase();
      const next = EFFORT_LEVELS.includes(first)
        ? setRuntimeConfig({ effort: first })
        : setRuntimeConfig({ model: args[0], effort: args[1] });
      await reply(
        message.message_id,
        `✅ Switched: model \`${next.model || 'CLI default'}\`, thinking effort \`${next.effort || 'CLI default'}\`\nTakes effect from the next message (no restart needed).`
      );
    } catch (e) {
      await reply(message.message_id, `⚠️ ${e?.message ?? e}`);
    }
    return;
  }
  if (text === '/cancel' || text === 'cancel') {
    // In a group the owner must also be able to stop a guest's runaway task (those are registered
    // under guest: keys)
    let killed = cancelRun(sessionKey);
    // While waiting out a backoff there is no live child process, yet the retry will still happen —
    // it has to be called off as well
    if (abortRetries(sessionKey)) killed = true;
    if (isOwner && message.chat_type !== 'p2p') {
      for (const k of runningKeysWithPrefix(`guest:${message.chat_id}:`)) {
        killed = cancelRun(k) || killed;
      }
    }
    await reply(message.message_id, killed ? '🛑 Cancelled the running task.' : 'Nothing is running right now.');
    return;
  }
  if (text === '/voice' || text === '/voice on' || text === '/voice off') {
    // Explicit switches no longer toggle: `/voice on` used to turn voice off when it was already
    // on, the exact opposite of what it says
    const on =
      text === '/voice on' ? true
      : text === '/voice off' ? false
      : !voiceChats.has(message.chat_id);
    if (on) voiceChats.add(message.chat_id); else voiceChats.delete(message.chat_id);
    await reply(message.message_id, on ? '🔊 Voice replies are on (each answer comes with an audio clip). Send /voice off to turn them off.' : '🔇 Voice replies are off.');
    return;
  }
  // A new instruction while a task is running: point at cancel / redirect
  if (isRunning(sessionKey) && !text.startsWith('/redirect')) {
    await reply(message.message_id, '⏳ The previous task is still running. Send **/cancel** to stop it, or **/redirect your new instruction** to cancel it and start over with new instructions (the session context is kept).');
    return;
  }
  // Attachments live in workspace/incoming/, and even non-owners get read-only access to that directory
  const extraTools = built.attachments.length ? ['Read(./incoming/**)'] : [];
  // NOTE: prompt must be declared BEFORE the /redirect branch. It used to be declared after it,
  // so /redirect hit the temporal dead zone (ReferenceError) every single time — and it crashed
  // *after* cancelRun, which killed the running task, never ran the new instruction and left the
  // user with no feedback at all. The command had not worked once since v1.3.0.
  let prompt = text;

  if (text.startsWith('/redirect')) {
    const extra = text.replace(/^\/redirect\s*/, '').trim();
    if (!extra) {
      await reply(message.message_id, 'Usage: /redirect <your new instruction>');
      return;
    }
    cancelRun(sessionKey);
    prompt = extra; // the session survives via --resume, so we continue straight with the new instruction
  }

  // Carry the sender's name in groups, so the bot knows who is talking.
  // Note this builds on prompt, not text — otherwise it would overwrite the new instruction
  // /redirect has just set
  if (message.chat_type !== 'p2p') {
    const name = await resolveSenderName(client, senderOpenId);
    if (name) prompt = `[group member ${name}]: ${prompt}`;
  }

  // Memory auto-recall: hint at the memory files that may be relevant (only the owner has memory/)
  if (isOwner) {
    const hint = recallHint(WORKSPACE_DIR, text);
    if (hint) prompt += `\n${hint}`;
  }

  // The previous turn already persisted memories after the nudge, so start this one on a fresh
  // session: everything worth keeping is in memory/, and dragging a million tokens of history
  // along just means paying for the same context twice
  if (isOwner && shouldRecycleSession(sessionKey)) {
    resetSession(sessionKey);
    console.log(`[context] ${sessionKey} memories persisted, recycling the session to reclaim context`);
  }

  // Context is approaching the compaction point: nudge the bot to persist memories first
  // (owner only — only the owner may write memory)
  if (isOwner && consumeMemoryNudge(sessionKey)) {
    prompt +=
      '\n\n(System note: this session is close to its context limit and will be auto-compacted shortly. ' +
      'Compaction only affects the conversation history, not the memory/ files. ' +
      'First check whether this stretch of conversation holds facts, decisions or preferences worth keeping that are not in memory/ yet — ' +
      'merge stable preferences into USER.md in place, give durable facts their own file and update the MEMORY.md index, ' +
      "and append process details to today's file under memory/journal/; " +
      'if there is nothing, ignore this note and answer the user normally. Do not let this note change the tone or structure of your reply.)';
    console.log(`[context] injected a persist-memory nudge into ${message.chat_id}`);
  }

  enqueue(sessionKey, async () => {
    console.log(`[msg] ${isOwner ? 'owner' : senderOpenId} @ ${message.chat_type} [${message.message_type}]: ${text.slice(0, 80)}`);
    await react(message.message_id, 'OnIt');
    const progress = createProgressChannel(client, message.message_id);
    try {
      const answer = await runClaude(sessionKey, prompt, isOwner, extraTools, progress.update);
      await progress.finish();
      await reply(message.message_id, answer || '(Claude returned an empty reply)');
      // Images and files the bot wrote into this turn's own outbox go out with this turn
      await flushOutbox(client, outboxDirFor(sessionKey, isOwner), (data) =>
        client.im.v1.message.reply({ path: { message_id: message.message_id }, data })
      );
      if (voiceChats.has(message.chat_id) && answer) {
        await sendVoice(client, answer, (data) =>
          client.im.v1.message.reply({ path: { message_id: message.message_id }, data })
        );
      }
      await react(message.message_id, 'DONE');
    } catch (e) {
      // Cancelled or failed, the progress card still has to be closed out — otherwise it sits on
      // "🔄 working" forever
      await progress.finish(e?.cancelled ? 'cancelled' : 'failed').catch(() => {});
      if (e?.cancelled) return; // stopped deliberately by /cancel, not an error
      console.error('[claude]', e);
      const msg = String(e.message ?? e);
      if (msg.includes('401') || /re-?authenticate/i.test(msg)) {
        await reply(
          message.message_id,
          '⚠️ The Claude login on the Mac has expired. Run `claude /login` in the Mac terminal to sign in again, then retry.'
        );
      } else {
        await reply(message.message_id, `⚠️ Claude call failed: ${msg}`);
      }
    }
  });
}

const eventDispatcher = new lark.EventDispatcher({}).register({
  'im.message.receive_v1': handleMessage,
});

// ---- Scheduled tasks: run Claude when due and push the result to the given chat ----
async function sendToChat(chatId, text) {
  const body = (data) =>
    client.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId, ...data } });
  const chunk = redact(text).slice(0, 20000);
  try {
    await body({
      msg_type: 'interactive',
      content: JSON.stringify({
        config: { wide_screen_mode: true },
        elements: [{ tag: 'markdown', content: chunk }],
      }),
    });
  } catch (e) {
    console.error('[sched] card send failed, falling back to plain text:', e?.message ?? e);
    await body({ msg_type: 'text', content: JSON.stringify({ text: chunk }) });
  }
}

const SCHEDULES_DIR = path.join(WORKSPACE_DIR, 'schedules');
const SCHED_STATE_FILE = path.join(WORKSPACE_DIR, '..', 'data', 'schedule-state.json');

// Next fire time: /help promises "last and next run", but only the last one was ever implemented
function nextFireAt(job) {
  if (job.enabled === false) return null;
  const when = String(job.when ?? '').trim();
  if (!when) return null;
  try {
    if (!when.startsWith('@') && !when.includes(' ')) {
      const t = new Date(when); // one-off job, local timezone
      return !isNaN(t) && t > new Date() ? t : null;
    }
    return CronExpressionParser.parse(when, { currentDate: new Date() }).next().toDate();
  } catch {
    return null;
  }
}

// /tasks: read the job definitions and the trigger state directly, so the owner can confirm at
// any time that the bot is in fact still working for them
function describeTasks() {
  try {
    const state = JSON.parse(fs.readFileSync(SCHED_STATE_FILE, 'utf8'));
    const files = fs.existsSync(SCHEDULES_DIR)
      ? fs.readdirSync(SCHEDULES_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('._'))
      : [];
    if (!files.length) return 'There are no scheduled tasks.';
    const lines = ['**Scheduled tasks**', ''];
    for (const f of files.sort()) {
      let job;
      try {
        job = JSON.parse(fs.readFileSync(path.join(SCHEDULES_DIR, f), 'utf8'));
      } catch {
        lines.push(`- ⚠️ \`${f}\` failed to parse`);
        continue;
      }
      const rec = state[f];
      const at = typeof rec === 'string' ? rec : rec?.at;
      const st = typeof rec === 'string' ? '' : rec?.status;
      const stLabel = { baseline: 'registered', running: 'running', done: 'done', failed: 'failed', 'skipped-late': 'skipped, too late' }[st] ?? '';
      const last = at ? `${new Date(at).toLocaleString('en-US')}${stLabel ? ` (${stLabel})` : ''}` : '(never fired)';
      const status = job.enabled === false ? '⏸ disabled' : '▶️ enabled';
      lines.push(`- ${status} **${job.name ?? f}** — \`${job.when}\``);
      lines.push(`  Last run: ${last}${job.action ? ` | action: ${job.action}` : ''}`);
      const next = nextFireAt(job);
      if (next) lines.push(`  Next run: ${next.toLocaleString('en-US')}`);
    }
    return lines.join('\n');
  } catch (e) {
    return `Failed to read the scheduled tasks: ${e?.message ?? e}`;
  }
}

// Startup notice: crashes and restarts used to be entirely silent, leaving the owner no way to
// know that the messages they sent were never picked up by anyone
const STARTUP_STAMP = path.join(WORKSPACE_DIR, '..', 'data', 'last-startup-notice');
async function announceStartup() {
  const owner = OWNER_OPEN_ID || loadOwner();
  if (!owner || process.env.STARTUP_NOTICE === 'false') return;
  // Do not push on every restart in a restart storm: notify at most once every 30 minutes
  try {
    const last = Number(fs.readFileSync(STARTUP_STAMP, 'utf8'));
    if (Number.isFinite(last) && Date.now() - last < 30 * 60 * 1000) {
      console.log('[startup-notice] less than 30 minutes since the last notice, skipping');
      return;
    }
  } catch { /* no such file on the first run */ }
  try { fs.writeFileSync(STARTUP_STAMP, String(Date.now())); } catch {}
  try {
    await client.im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: owner,
        msg_type: 'text',
        content: JSON.stringify({
          text: `🤖 The bridge is up (${new Date().toLocaleString('en-US')}). If you sent anything earlier and got no reply, please send it again.`,
        }),
      },
    });
  } catch (e) {
    console.error('[startup-notice]', e?.message ?? e);
  }
}

startScheduler({
  schedulesDir: SCHEDULES_DIR,
  stateFile: SCHED_STATE_FILE,
  onFire: async (job) => {
    const chatId = job.chat_id;
    // Action jobs: switch model / thinking effort without calling Claude at all
    if (job.action === 'set-model') {
      try {
        const next = setRuntimeConfig({ model: job.model, effort: job.effort });
        console.log(`[sched] model switched → ${next.model} / ${next.effort}`);
        if (chatId) {
          await sendToChat(chatId, `🔀 **${job.name ?? 'Scheduled switch'}**: model \`${next.model || 'CLI default'}\`, thinking effort \`${next.effort || 'CLI default'}\``);
        }
      } catch (e) {
        console.error('[sched] model switch failed:', e?.message ?? e);
        if (chatId) await sendToChat(chatId, `⚠️ Scheduled model switch failed: ${e?.message ?? e}`);
      }
      return;
    }
    if (!chatId) {
      console.error(`[sched] job "${job.name ?? job._file}" has no chat_id, skipping`);
      return;
    }
    // Scheduled tasks run in their own session context, so they cannot pollute an ongoing conversation
    const schedChatId = `sched:${job._file}`;
    try {
      const answer = await runClaude(
        schedChatId,
        job.prompt,
        true,
        [],
        (p) => sendToChat(chatId, `⏳ ${p}`),
        { model: job.model, effort: job.effort } // a job may carry its own tier; falls back to the global config
      );
      const late = job._late ? ` (late by ${Math.round(job._late / 60000)} min)` : '';
      // Say nothing when there is nothing to say: skip silently when the answer starts with
      // HEARTBEAT_OK (or is empty), which is what makes "check this daily, only ping me if
      // something is wrong" heartbeat jobs possible.
      // The whole answer has to be the heartbeat word: a prefix match would swallow an alert like
      // "HEARTBEAT_OK but the disk is nearly full" body and all
      const body = (answer ?? '').trim();
      const quiet = !body || /^HEARTBEAT_OK[.!]?$/i.test(body);
      if (quiet) {
        console.log(`[sched] "${job.name ?? job._file}" had nothing to report, skipping silently`);
      } else {
        await sendToChat(chatId, `⏰ **${job.name ?? 'Scheduled task'}**${late}\n\n${body}`);
      }
      // Files written by scheduled tasks were never sent before; they lingered until the next
      // arbitrary message happened to sweep them out
      await flushOutbox(client, outboxDirFor(schedChatId, true), (data) =>
        client.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId, ...data } })
      );
    } catch (e) {
      // Self-diagnosis on failure: let Claude work out the cause and whether it can fix itself
      const err = String(e?.message ?? e).slice(0, 800);
      console.error(`[sched] job failed, starting self-diagnosis: ${err}`);
      let diag = '';
      try {
        diag = await runClaude(
          `sched-diag:${job._file}`,
          // Self-diagnosis is a short, templated task — no need for a flagship model
          [
            'You are the diagnostician for scheduled tasks. The job below failed to run; work out why and give a verdict.',
            `Job name: ${job.name ?? job._file}`,
            `Job prompt: ${job.prompt}`,
            `Error: ${err}`,
            '',
            'Answer in three lines: 1) failure category (permissions / network / quota / the job itself is written wrong / other); 2) root cause; 3) recommended action (if it can be fixed automatically, say how to change the job definition; if a human is needed, state exactly what they must do). Do not retry the job.',
          ].join('\n'),
          true,
          [],
          null,
          { model: process.env.DIAG_MODEL || 'claude-haiku-4-5-20251001', effort: 'low' }
        );
      } catch (e2) {
        diag = `(the diagnosis failed too: ${String(e2?.message ?? e2).slice(0, 200)})`;
      }
      await sendToChat(
        chatId,
        `⚠️ **Scheduled task failed**: ${job.name ?? job._file}\n\nError: \`${err.slice(0, 300)}\`\n\n**Self-diagnosis**\n${diag}`
      );
      // Drain this job's outbox on failure too, or the leftover files ride along with the next report
      await flushOutbox(client, outboxDirFor(schedChatId, true), (data) =>
        client.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId, ...data } })
      ).catch(() => {});
    }
  },
});

// The attachment directory only ever grows (24 MB observed in practice) — clean it once at
// startup and once a day after that
cleanIncoming(WORKSPACE_DIR);
cleanIncoming(GUEST_WORKSPACE_DIR);
setInterval(() => {
  cleanIncoming(WORKSPACE_DIR);
  cleanIncoming(GUEST_WORKSPACE_DIR);
}, 24 * 3600 * 1000).unref();

console.log('Starting the Lark persistent connection…');
wsClient.start({ eventDispatcher });
announceStartup();

// Print the configuration actually in effect: dotenv does not override existing env vars,
// so exporting CLAUDE_MODEL/CLAUDE_EFFORT in a shell and starting by hand silently ignores .env
{
  const cfg = getRuntimeConfig();
  const shadowed = ['CLAUDE_MODEL', 'CLAUDE_EFFORT', 'GUEST_TOOLS', 'OWNER_OPEN_ID']
    .filter((k) => {
      try {
        const line = fs.readFileSync(path.resolve(process.cwd(), '.env'), 'utf8')
          .split('\n').find((l) => l.startsWith(`${k}=`));
        const inFile = line ? line.slice(k.length + 1).replace(/\s+#.*$/, '').trim() : null;
        return inFile && process.env[k] && process.env[k] !== inFile;
      } catch { return false; }
    });
  console.log(`[config] effective: model=${cfg.model || 'CLI default'} effort=${cfg.effort || 'CLI default'}`);
  const cli = checkCliEnvironment(cfg.model);
  console.log(`[config] claude CLI: ${cli.bin} (${cli.version ?? 'unknown'})`);
  if (cli.problem) console.error(`[config] WARNING: ${cli.problem}`);
  if (shadowed.length) {
    console.error(`[config] WARNING: shadowed by the shell environment, .env values ignored: ${shadowed.join(', ')}`);
  }
}

