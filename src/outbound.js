// 出站能力：进度卡片原地更新、图片/文件回传、发送者姓名解析
import fs from 'node:fs';
import path from 'node:path';

const card = (text) => ({
  config: { wide_screen_mode: true },
  elements: [{ tag: 'markdown', content: text.slice(0, 20000) }],
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
    const body = `⏳ **处理中**\n\n${lines.map((l) => `- ${l}`).join('\n')}`;
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
        data: { content: JSON.stringify(card(`✅ 已完成（${lines.length} 个步骤）`)) },
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
