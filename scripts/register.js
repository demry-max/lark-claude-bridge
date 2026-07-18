// 一键注册飞书应用（移植自 OpenClaw 的设备码注册流程）：
// 扫码授权后，飞书官方接口直接返回 appId + appSecret + 用户 open_id，
// 自动写入 .env 与 data/owner.json —— 无需进开发者后台建应用。
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// FEISHU_DOMAIN=lark 时走国际版 Lark 注册端点
const REG_URL =
  process.env.FEISHU_DOMAIN === 'lark'
    ? 'https://accounts.larksuite.com/oauth/v1/app/registration'
    : 'https://accounts.feishu.cn/oauth/v1/app/registration';

async function post(body) {
  const res = await fetch(REG_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  return res.json(); // pending/error 状态也带 JSON body
}

function upsertEnv(appId, appSecret) {
  const envPath = path.join(ROOT, '.env');
  let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const set = (key, val) => {
    const line = `${key}=${val}`;
    env = new RegExp(`^${key}=`, 'm').test(env)
      ? env.replace(new RegExp(`^${key}=.*$`, 'm'), line)
      : env + (env.endsWith('\n') || env === '' ? '' : '\n') + line + '\n';
  };
  set('FEISHU_APP_ID', appId);
  set('FEISHU_APP_SECRET', appSecret);
  fs.writeFileSync(envPath, env);
}

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

const init = await post({ action: 'init' });
if (!init.supported_auth_methods?.includes('client_secret')) {
  console.error('当前环境不支持 client_secret 注册方式:', JSON.stringify(init).slice(0, 200));
  process.exit(1);
}

const begin = await post({
  action: 'begin',
  archetype: 'PersonalAgent',
  auth_method: 'client_secret',
  request_user_info: 'open_id',
});
if (!begin.device_code) {
  console.error('注册启动失败:', JSON.stringify(begin).slice(0, 300));
  process.exit(1);
}

const qrUrl = begin.verification_uri_complete;
try {
  const qr = await import('qrcode-terminal');
  qr.default.generate(qrUrl, { small: true });
} catch {
  /* 未安装 qrcode-terminal 时仅打印链接 */
}
console.log('\n请用飞书 App 扫上方二维码，或在手机浏览器打开：\n' + qrUrl + '\n');
console.log(`等待授权（${begin.expire_in || 600} 秒内有效）…`);

let interval = begin.interval || 5;
const deadline = Date.now() + (begin.expire_in || 600) * 1000;

while (Date.now() < deadline) {
  await sleep(interval);
  let p;
  try {
    p = await post({ action: 'poll', device_code: begin.device_code, tp: 'ob_cli_app' });
  } catch {
    continue; // 网络抖动继续轮询
  }
  if (p.client_id && p.client_secret) {
    upsertEnv(p.client_id, p.client_secret);
    const openId = p.user_info?.open_id;
    if (openId) {
      const ownerPath = path.join(ROOT, 'data', 'owner.json');
      if (!fs.existsSync(ownerPath)) {
        fs.mkdirSync(path.dirname(ownerPath), { recursive: true });
        fs.writeFileSync(ownerPath, JSON.stringify({ open_id: openId }, null, 2));
        console.log(`✅ 已将扫码人设为 owner（${openId}）`);
      }
    }
    console.log(`✅ 应用创建成功：${p.client_id}，凭据已写入 .env`);
    console.log('下一步：npm start 启动机器人，到飞书私聊它发「你好」。');
    process.exit(0);
  }
  if (p.error === 'authorization_pending') continue;
  if (p.error === 'slow_down') { interval += 2; continue; }
  if (p.error) {
    console.error(`注册失败: ${p.error} ${p.error_description ?? ''}`);
    process.exit(1);
  }
}
console.error('授权超时，请重新运行 npm run register');
process.exit(1);
