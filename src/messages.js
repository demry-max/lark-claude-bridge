import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';

function toPcm16k(src) {
  const dest = src.replace(/\.\w+$/, '') + '.pcm';
  return new Promise((resolve, reject) => {
    execFile(
      FFMPEG,
      ['-y', '-i', src, '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '16000', dest],
      (err, _out, stderr) =>
        err ? reject(new Error(`ffmpeg 转码失败: ${String(stderr).slice(-200)}`)) : resolve(dest)
    );
  });
}

// 飞书语音文件识别（仅收 16k PCM，≤60s）
async function feishuAsr(client, audioPath) {
  const pcm = await toPcm16k(audioPath);
  const b64 = fs.readFileSync(pcm).toString('base64');
  const res = await client.request({
    method: 'POST',
    url: '/open-apis/speech_to_text/v1/speech/file_recognize',
    data: {
      speech: { speech: b64 },
      config: {
        engine_type: '16k_auto',
        format: 'pcm',
        // file_id 必须是恰好 16 位字母数字下划线
        file_id: (path.basename(audioPath).replace(/\W/g, '') + '_padding_0000000').slice(0, 16),
      },
    },
  });
  return String(res?.recognition_text ?? res?.data?.recognition_text ?? '').trim();
}

function safeParse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function stripMentions(text) {
  return (text ?? '').replace(/@_user_\d+/g, '').trim();
}

async function download(client, messageId, fileKey, type, incomingDir, fileName) {
  fs.mkdirSync(incomingDir, { recursive: true });
  const dest = path.join(incomingDir, path.basename(fileName));
  const res = await client.im.v1.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type },
  });
  await res.writeFile(dest);
  return dest;
}

// 从 post 富文本节点树提取文字与图片 key
function walkPost(content) {
  const texts = [];
  const imageKeys = [];
  const rows = Array.isArray(content?.content) ? content.content : [];
  for (const row of rows) {
    const line = [];
    for (const node of row ?? []) {
      if (node.tag === 'text') line.push(node.text ?? '');
      else if (node.tag === 'a') line.push(`${node.text ?? ''}(${node.href ?? ''})`);
      else if (node.tag === 'img') imageKeys.push(node.image_key);
      else if (node.tag === 'at') line.push('');
    }
    if (line.length) texts.push(line.join(''));
  }
  return { text: texts.join('\n'), imageKeys };
}

/**
 * 把一条飞书消息转成给 Claude 的提示词。
 * 返回 { prompt, attachments }；attachments 非空时需要给 Claude 开 Read(./incoming/**) 权限。
 */
export async function buildPrompt(client, message, workspaceDir) {
  const type = message.message_type;
  const content = safeParse(message.content);
  const incomingDir = path.join(workspaceDir, 'incoming', message.message_id);
  const rel = (p) => `./${path.relative(workspaceDir, p)}`;

  switch (type) {
    case 'text':
      return { prompt: stripMentions(content.text), attachments: [] };

    case 'image': {
      const p = await download(
        client, message.message_id, content.image_key, 'image', incomingDir, `${content.image_key}.png`
      );
      return {
        prompt: `用户发来一张图片，已保存为 ${rel(p)}。请用 Read 工具查看图片内容，然后回应用户。`,
        attachments: [p],
      };
    }

    case 'file': {
      const name = content.file_name || `${content.file_key}.bin`;
      const p = await download(
        client, message.message_id, content.file_key, 'file', incomingDir, name
      );
      return {
        prompt: `用户发来一个文件「${name}」，已保存为 ${rel(p)}。请用 Read 工具查看文件内容，然后回应用户。`,
        attachments: [p],
      };
    }

    case 'post': {
      const { text, imageKeys } = walkPost(content);
      const attachments = [];
      for (const key of imageKeys) {
        try {
          attachments.push(
            await download(client, message.message_id, key, 'image', incomingDir, `${key}.png`)
          );
        } catch (e) {
          console.error('[post-img]', e?.message ?? e);
        }
      }
      const title = content.title ? `【${content.title}】\n` : '';
      let prompt = `${title}${stripMentions(text)}`;
      if (attachments.length) {
        prompt += `\n\n（消息附带 ${attachments.length} 张图片，已保存为：${attachments
          .map(rel)
          .join('、')}。请用 Read 工具查看后一并回应。）`;
      }
      return { prompt, attachments };
    }

    case 'merge_forward': {
      // 合并转发：拉取子消息逐条拼接
      const res = await client.im.v1.message.get({ path: { message_id: message.message_id } });
      const items = res?.data?.items ?? [];
      const lines = [];
      for (const item of items) {
        if (item.message_id === message.message_id) continue;
        const body = safeParse(item.body?.content);
        if (item.msg_type === 'text') lines.push(stripMentions(body.text));
        else if (item.msg_type === 'post') lines.push(walkPost(body).text);
        else lines.push(`[${item.msg_type} 消息]`);
      }
      return {
        prompt: `用户转发了一组聊天记录，内容如下：\n---\n${lines.join('\n')}\n---\n请理解后回应用户。`,
        attachments: [],
      };
    }

    case 'audio': {
      // ① 飞书自动语音转文字（租户开启后 content 自带该字段）
      const stt = typeof content.speech_to_text === 'string' ? content.speech_to_text.trim() : '';
      if (stt) {
        return { prompt: `（用户发来一条语音，转写内容如下）\n${stt}`, attachments: [] };
      }
      if (Number(content.duration ?? 0) > 60_000) {
        return { prompt: null, attachments: [], unsupported: '这条语音超过 60 秒，自动转写不支持，请分段发送或改发文字。' };
      }
      // ② 兜底：下载 opus → ffmpeg 转 16k PCM → 飞书语音识别 API
      try {
        const p = await download(
          client, message.message_id, content.file_key, 'file', incomingDir, `${content.file_key}.opus`
        );
        const text = await feishuAsr(client, p);
        if (text) {
          return { prompt: `（用户发来一条语音，识别内容如下）\n${text}`, attachments: [] };
        }
        return { prompt: null, attachments: [], unsupported: '语音已收到，但没有识别出内容，请重试或改发文字。' };
      } catch (e) {
        return {
          prompt: null,
          attachments: [],
          unsupported: `语音转写失败：${e?.message ?? e}\n（若是权限问题，请在开发者后台开通 speech_to_text:speech 并发布版本）`,
        };
      }
    }

    case 'media':
    case 'sticker':
      return { prompt: null, attachments: [], unsupported: `暂不支持${type === 'media' ? '视频' : '表情包'}消息。` };

    default:
      // 分享卡片/邮件卡片等：把原始 JSON 交给 Claude 理解
      return {
        prompt: `用户发来一条「${type}」类型的飞书消息，原始内容 JSON 如下：\n\`\`\`json\n${String(
          message.content
        ).slice(0, 6000)}\n\`\`\`\n请从中提取有用信息，理解后回应用户。`,
        attachments: [],
      };
  }
}
