import 'dotenv/config';
import * as lark from '@larksuiteoapi/node-sdk';
import path from 'node:path';
import { runClaude, resetSession, sessionInfo, WORKSPACE_DIR, cancelRun, isRunning } from './claude.js';
import { buildPrompt } from './messages.js';
import { loadOwner, saveOwner } from './store.js';
import { startScheduler } from './scheduler.js';
import { createProgressChannel, flushOutbox, resolveSenderName, redact, sendVoice } from './outbound.js';

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;

if (!APP_ID || !APP_SECRET) {
  console.error('缺少 FEISHU_APP_ID / FEISHU_APP_SECRET，请检查 .env');
  process.exit(1);
}

// FEISHU_DOMAIN=lark 时接入国际版 Lark（open.larksuite.com）
const DOMAIN = process.env.FEISHU_DOMAIN === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu;

const client = new lark.Client({ appId: APP_ID, appSecret: APP_SECRET, domain: DOMAIN });
const wsClient = new lark.WSClient({
  appId: APP_ID,
  appSecret: APP_SECRET,
  domain: DOMAIN,
  loggerLevel: lark.LoggerLevel.info,
});

// ---- 访问控制：留空=保持原行为（全员可私聊）；配置后仅名单内可用 ----
const parseList = (v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const ALLOW_USERS = parseList(process.env.ALLOW_USERS); // open_id 白名单
const ALLOW_CHATS = parseList(process.env.ALLOW_CHATS); // chat_id 白名单（群）
const OUTBOX_DIR = path.join(WORKSPACE_DIR, 'outbox');
const voiceChats = new Set(); // 开启语音回复的会话

function isAllowed(openId, chatId, isP2p) {
  if (isP2p) return ALLOW_USERS.length === 0 || ALLOW_USERS.includes(openId);
  if (ALLOW_CHATS.length && !ALLOW_CHATS.includes(chatId)) return false;
  return ALLOW_USERS.length === 0 || ALLOW_USERS.includes(openId);
}

const HELP_TEXT = [
  '**可用指令**',
  '- `/new` 开启全新会话（忘掉此前上下文）',
  '- `/status` 查看会话、模型、思考深度、可用工具',
  '- `/help` 显示本说明',
  '- `/cancel` 取消正在跑的任务',
  '- `/redirect <新要求>` 中断当前任务并按新要求重来',
  '- `/voice` 切换语音回复（回答附带一条语音）',
  '',
  '**能做什么**',
  '- 直接对话；群里 @我 即可',
  '- 发图片 / 文件 / 语音，我会读内容后回答',
  '- 说「记住…」我会写进长期记忆，跨会话生效',
  '- 说「存成技能」我会把流程固化下来，以后自动遵循',
  '- 说「每天八点提醒我…」我会自己排定时任务',
].join('\n');

// ---- 消息去重（飞书事件可能重投） ----
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

// ---- 每个会话串行处理，避免并发 resume 冲突 ----
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
      // markdown 卡片失败时降级纯文本
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
    // 无 reaction 权限时静默跳过
  }
}

// ---- 机器人自身 open_id（用于识别群聊 @提及） ----
let botOpenId = null;
async function getBotOpenId() {
  if (botOpenId) return botOpenId;
  try {
    const res = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' });
    botOpenId = res?.bot?.open_id ?? null;
    if (botOpenId) console.log(`[bot] open_id = ${botOpenId}`);
  } catch (e) {
    console.error('[bot] 获取机器人信息失败:', e?.message ?? e);
  }
  return botOpenId;
}

async function handleMessage(data) {
  const message = data.message;
  const senderOpenId = data.sender?.sender_id?.open_id;
  if (!message || !senderOpenId) return;
  if (isDuplicate(message.message_id)) return;

  // 群聊仅在 @机器人 时响应
  if (message.chat_type !== 'p2p') {
    const bot = await getBotOpenId();
    const mentioned = (message.mentions ?? []).some(
      (m) => m?.id?.open_id && m.id.open_id === bot
    );
    if (!mentioned) return;
  }

  if (!isAllowed(senderOpenId, message.chat_id, message.chat_type === 'p2p')) {
    console.log(`[deny] ${senderOpenId} @ ${message.chat_id} 不在白名单`);
    return;
  }

  // ---- owner：首个私聊者自动认领，owner 享有本机工具，其他人仅联网工具 ----
  let owner = loadOwner();
  if (!owner && message.chat_type === 'p2p') {
    owner = senderOpenId;
    saveOwner(owner);
    console.log(`[owner] 已锁定 owner open_id = ${owner}`);
    await reply(
      message.message_id,
      `✅ 已将你登记为本机器人 owner（open_id: \`${owner}\`）。\n直接发消息即可对话；发送 **/new** 开启新会话，**/status** 查看会话状态。`
    );
    return;
  }
  const isOwner = senderOpenId === owner;

  // ---- 消息 → 提示词（文本/图片/文件/富文本/合并转发/卡片） ----
  let built;
  try {
    built = await buildPrompt(client, message, WORKSPACE_DIR);
  } catch (e) {
    console.error('[buildPrompt]', e);
    await reply(
      message.message_id,
      `⚠️ 处理该消息失败：${e?.message ?? e}\n（若是图片/文件，请确认应用已开通 im:resource 权限并发布版本）`
    );
    return;
  }
  if (built.unsupported) {
    await reply(message.message_id, built.unsupported);
    return;
  }
  const text = built.prompt?.trim();
  if (!text) return;

  // ---- 内置命令 ----
  if (text === '/new') {
    resetSession(message.chat_id);
    await reply(message.message_id, '🆕 已重置，下一条消息将开启全新 Claude 会话。');
    return;
  }
  if (text === '/status') {
    await reply(message.message_id, sessionInfo(message.chat_id, isOwner));
    return;
  }
  if (text === '/help' || text === '帮助') {
    await reply(message.message_id, HELP_TEXT);
    return;
  }
  if (text === '/cancel' || text === '取消') {
    const killed = cancelRun(message.chat_id);
    await reply(message.message_id, killed ? '🛑 已取消当前任务。' : '当前没有正在运行的任务。');
    return;
  }
  if (text === '/voice' || text === '/voice on' || text === '/voice off') {
    const on = text !== '/voice off' && !voiceChats.has(message.chat_id);
    if (on) voiceChats.add(message.chat_id); else voiceChats.delete(message.chat_id);
    await reply(message.message_id, on ? '🔊 已开启语音回复（回答会附一条语音）。再发 /voice 关闭。' : '🔇 已关闭语音回复。');
    return;
  }
  // 任务进行中收到新指令：提示可取消/重定向
  if (isRunning(message.chat_id) && !text.startsWith('/redirect')) {
    await reply(message.message_id, '⏳ 上一个任务还在跑。发 **/cancel** 取消，或 **/redirect 你的新要求** 取消并按新要求重来（会话上下文保留）。');
    return;
  }
  if (text.startsWith('/redirect')) {
    const extra = text.replace(/^\/redirect\s*/, '').trim();
    if (!extra) {
      await reply(message.message_id, '用法：/redirect 你的新要求');
      return;
    }
    cancelRun(message.chat_id);
    prompt = extra; // 会话通过 --resume 保留，直接以新要求继续
  }

  // 附件存放于 workspace/incoming/，即使非 owner 也放行该目录的只读访问
  const extraTools = built.attachments.length ? ['Read(./incoming/**)'] : [];
  let prompt = text;

  // 群聊带上发言人姓名，机器人才知道是谁在说话
  if (message.chat_type !== 'p2p') {
    const name = await resolveSenderName(client, senderOpenId);
    if (name) prompt = `[群成员 ${name}]：${text}`;
  }

  enqueue(message.chat_id, async () => {
    console.log(`[msg] ${isOwner ? 'owner' : senderOpenId} @ ${message.chat_type} [${message.message_type}]: ${text.slice(0, 80)}`);
    await react(message.message_id, 'OnIt');
    const progress = createProgressChannel(client, message.message_id);
    try {
      const answer = await runClaude(message.chat_id, prompt, isOwner, extraTools, progress.update);
      await progress.finish();
      await reply(message.message_id, answer || '（Claude 返回了空回复）');
      // 机器人写进 outbox 的图片/文件随本轮一起回传
      await flushOutbox(client, OUTBOX_DIR, (data) =>
        client.im.v1.message.reply({ path: { message_id: message.message_id }, data })
      );
      if (voiceChats.has(message.chat_id) && answer) {
        await sendVoice(client, answer, (data) =>
          client.im.v1.message.reply({ path: { message_id: message.message_id }, data })
        );
      }
      await react(message.message_id, 'DONE');
    } catch (e) {
      if (e?.cancelled) return; // /cancel 主动终止，不报错
      console.error('[claude]', e);
      const msg = String(e.message ?? e);
      if (msg.includes('401') || /re-?authenticate/i.test(msg)) {
        await reply(
          message.message_id,
          '⚠️ Mac 上的 Claude 登录已过期。请在 Mac 终端运行 `claude /login` 重新登录后再试。'
        );
      } else {
        await reply(message.message_id, `⚠️ Claude 调用失败：${msg}`);
      }
    }
  });
}

const eventDispatcher = new lark.EventDispatcher({}).register({
  'im.message.receive_v1': handleMessage,
});

// ---- 定时任务：到点跑 Claude，把结果主动发到指定会话 ----
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
    console.error('[sched] 卡片发送失败，降级纯文本:', e?.message ?? e);
    await body({ msg_type: 'text', content: JSON.stringify({ text: chunk }) });
  }
}

startScheduler({
  schedulesDir: path.join(WORKSPACE_DIR, 'schedules'),
  stateFile: path.join(WORKSPACE_DIR, '..', 'data', 'schedule-state.json'),
  onFire: async (job) => {
    const chatId = job.chat_id;
    if (!chatId) {
      console.error(`[sched] 任务「${job.name ?? job._file}」缺 chat_id，跳过`);
      return;
    }
    // 定时任务用独立会话上下文，避免污染用户正在进行的对话
    try {
      const answer = await runClaude(`sched:${job._file}`, job.prompt, true, [], (p) =>
        sendToChat(chatId, `⏳ ${p}`)
      );
      await sendToChat(chatId, `⏰ **${job.name ?? '定时任务'}**\n\n${answer || '（无输出）'}`);
    } catch (e) {
      // 失败自诊断：让 Claude 判断是什么原因、能否自行修复
      const err = String(e?.message ?? e).slice(0, 800);
      console.error(`[sched] 任务失败，启动自诊断: ${err}`);
      let diag = '';
      try {
        diag = await runClaude(
          `sched-diag:${job._file}`,
          [
            '你是定时任务的诊断助手。以下任务执行失败，请判断原因并给出结论。',
            `任务名：${job.name ?? job._file}`,
            `任务指令：${job.prompt}`,
            `报错：${err}`,
            '',
            '请用三行回答：1) 失败类别（权限/网络/额度/任务本身写错/其他）；2) 根因判断；3) 建议动作（能自行修复就说明怎么改任务定义，需要人工就明确说要做什么）。不要重试该任务。',
          ].join('\n'),
          true
        );
      } catch (e2) {
        diag = `（诊断也失败了：${String(e2?.message ?? e2).slice(0, 200)}）`;
      }
      await sendToChat(
        chatId,
        `⚠️ **定时任务失败**：${job.name ?? job._file}\n\n报错：\`${err.slice(0, 300)}\`\n\n**自诊断**\n${diag}`
      );
    }
  },
});

console.log('启动飞书长连接…');
wsClient.start({ eventDispatcher });
