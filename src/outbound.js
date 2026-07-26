// 出站能力：进度卡片原地更新、图片/文件回传、发送者姓名解析
import fs from 'node:fs';
import path from 'node:path';


// ---- 出站脱敏：回复送出前抹掉密钥/令牌/内网地址，避免误发到群里 ----
const SECRET_PATTERNS = [
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, 'sk-ant-***'],
  [/\bbms_sk_[A-Za-z0-9_-]{8,}/g, 'bms_sk_***'],
  [/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/g, 'github_token_***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'jwt_***'],
  [/\b(?:Bearer|token|secret|password|api[_-]?key)\s*[:=]\s*["']?([A-Za-z0-9_\-]{16,})["']?/gi, (m) => m.replace(/[A-Za-z0-9_\-]{16,}$/, '***')],
  [/\b(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '10.x.x.x'],
  [/\b192\.168\.\d{1,3}\.\d{1,3}\b/g, '192.168.x.x'],
  [/\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/g, '172.x.x.x'],
];
// 运行时凭据（.env 里的真实值）也一并抹掉
const runtimeSecrets = [process.env.FEISHU_APP_SECRET, process.env.CLAUDE_CODE_OAUTH_TOKEN]
  .filter((v) => v && v.length >= 12);

export function redact(text) {
  let out = String(text ?? '');
  for (const v of runtimeSecrets) out = out.split(v).join('***');
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

const card = (text) => ({
  config: { wide_screen_mode: true },
  elements: [{ tag: 'markdown', content: redact(text).slice(0, 20000) }],
});

/**
 * 进度会话：首条进度发一张卡片，后续进度**原地更新同一张卡片**（不再刷屏）。
 * 返回 { update, finish }：update 推进度，finish 收尾（把卡片改成折叠态）。
 */
export function createProgressChannel(client, messageId) {
  let cardMessageId = null;
  const lines = [];

  const update = async (text) => {
    lines.push(text);
    const body = [
      '🔄 **处理中**',
      '',
      ...lines.map((l, i) => `${i === lines.length - 1 ? '🔄' : '✅'} ${l}`),
    ].join('\n');
    try {
      if (!cardMessageId) {
        const res = await client.im.v1.message.reply({
          path: { message_id: messageId },
          data: { msg_type: 'interactive', content: JSON.stringify(card(body)) },
        });
        cardMessageId = res?.data?.message_id ?? res?.message_id ?? null;
      } else {
        await client.im.v1.message.patch({
          path: { message_id: cardMessageId },
          data: { content: JSON.stringify(card(body)) },
        });
      }
    } catch (e) {
      console.error('[progress]', e?.message ?? e);
    }
  };

  // 收尾：把进度卡片改成一行折叠说明，正式答案另发
  const finish = async () => {
    if (!cardMessageId || !lines.length) return;
    try {
      await client.im.v1.message.patch({
        path: { message_id: cardMessageId },
        data: { content: JSON.stringify(card([`✅ **已完成**（${lines.length} 步）`, '', ...lines.map((l) => `✅ ${l}`)].join('\n'))) },
      });
    } catch (e) {
      console.error('[progress-finish]', e?.message ?? e);
    }
  };

  return { update, finish };
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

/**
 * 回传附件：机器人把要发的文件写进 workspace/outbox/，本函数发送后清空。
 * 图片走图片消息（飞书直接预览），其余走文件消息。
 */
export async function flushOutbox(client, outboxDir, sendRaw) {
  if (!fs.existsSync(outboxDir)) return 0;
  const files = fs
    .readdirSync(outboxDir)
    .filter((f) => !f.startsWith('.') && fs.statSync(path.join(outboxDir, f)).isFile());
  let sent = 0;
  for (const name of files) {
    const p = path.join(outboxDir, name);
    try {
      const ext = path.extname(name).toLowerCase();
      if (IMAGE_EXT.has(ext)) {
        const up = await client.im.v1.image.create({
          data: { image_type: 'message', image: fs.createReadStream(p) },
        });
        const key = up?.image_key ?? up?.data?.image_key;
        if (!key) throw new Error('上传图片未返回 image_key');
        await sendRaw({ msg_type: 'image', content: JSON.stringify({ image_key: key }) });
      } else {
        const up = await client.im.v1.file.create({
          data: { file_type: 'stream', file_name: name, file: fs.createReadStream(p) },
        });
        const key = up?.file_key ?? up?.data?.file_key;
        if (!key) throw new Error('上传文件未返回 file_key');
        await sendRaw({ msg_type: 'file', content: JSON.stringify({ file_key: key }) });
      }
      sent++;
    } catch (e) {
      console.error(`[outbox] 发送 ${name} 失败:`, e?.message ?? e);
    } finally {
      fs.rmSync(p, { force: true }); // 无论成败都清掉，避免下次重复发送
    }
  }
  return sent;
}

// 发送者姓名解析（群里知道是谁在说话）；失败或无权限时静默降级
const nameCache = new Map();
export async function resolveSenderName(client, openId) {
  if (!openId) return null;
  if (nameCache.has(openId)) return nameCache.get(openId);
  let name = null;
  try {
    const res = await client.contact.v3.user.get({
      path: { user_id: openId },
      params: { user_id_type: 'open_id' },
    });
    name = res?.data?.user?.name ?? res?.user?.name ?? null;
  } catch {
    // 未开通通讯录权限时忽略
  }
  nameCache.set(openId, name);
  return name;
}

// ---- 语音回传（TTS）：macOS say 合成 → ffmpeg 转 opus → 飞书语音消息 ----
// 需要 macOS 的 say 与 ffmpeg（libopus）。失败时静默跳过，不影响文字回复。
import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);

const TTS_VOICE = process.env.TTS_VOICE || 'Tingting'; // 中文女声；英文可用 Samantha
const TTS_MAX_CHARS = Number(process.env.TTS_MAX_CHARS || 500);

export async function sendVoice(client, text, sendRaw) {
  if (process.platform !== 'darwin') return false;
  // 去掉 markdown 记号，长文截断（语音过长反而难用）
  const plain = redact(text)
    .replace(/```[\s\S]*?```/g, '（代码块略）')
    .replace(/[*_`#>|]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TTS_MAX_CHARS);
  if (!plain) return false;

  const base = path.join(os.tmpdir(), `tts-${Date.now()}`);
  const aiff = `${base}.aiff`;
  const opus = `${base}.opus`;
  try {
    await execFileP('say', ['-v', TTS_VOICE, '-o', aiff, plain]);
    await execFileP(process.env.FFMPEG_BIN || 'ffmpeg', [
      '-y', '-i', aiff, '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '32k', opus,
    ]);
    const { stdout } = await execFileP(process.env.FFMPEG_BIN || 'ffmpeg', ['-i', opus], { encoding: 'utf8' }).catch((e) => ({ stdout: e.stderr ?? '' }));
    const m = String(stdout).match(/Duration: (\d+):(\d+):([\d.]+)/);
    const durationMs = m ? Math.round(((+m[1] * 3600 + +m[2] * 60 + parseFloat(m[3])) * 1000)) : 1000;

    const up = await client.im.v1.file.create({
      data: { file_type: 'opus', file_name: 'reply.opus', duration: String(durationMs), file: fs.createReadStream(opus) },
    });
    const key = up?.file_key ?? up?.data?.file_key;
    if (!key) throw new Error('上传语音未返回 file_key');
    await sendRaw({ msg_type: 'audio', content: JSON.stringify({ file_key: key }) });
    return true;
  } catch (e) {
    console.error('[tts]', e?.message ?? e);
    return false;
  } finally {
    for (const f of [aiff, opus]) fs.rmSync(f, { force: true });
  }
}
