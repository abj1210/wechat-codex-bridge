import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import qrcode from 'qrcode-terminal';

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const DEFAULT_BOT_TYPE = '3';
export const CHANNEL_VERSION = '2.4.6';
export const BOT_AGENT = 'wechat-codex-bridge/0.1.0';
export const ILINK_APP_ID = 'bot';

/** 腾讯 iLink 的客户端版本编码：major<<16 | minor<<8 | patch。 */
export function buildClientVersion(version = CHANNEL_VERSION) {
  const [major = 0, minor = 0, patch = 0] = version
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

export function randomWechatUin() {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf8').toString('base64');
}

function ensureBase(baseUrl) {
  const url = String(baseUrl || DEFAULT_BASE_URL);
  return url.endsWith('/') ? url : `${url}/`;
}

function buildCommonHeaders() {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(buildClientVersion(CHANNEL_VERSION)),
  };
}

function buildHeaders({ token } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    ...buildCommonHeaders(),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function redact(value) {
  const text = String(value ?? '');
  if (!text) return text;
  if (text.length <= 12) return `${text.slice(0, 2)}***${text.slice(-2)}`;
  return `${text.slice(0, 6)}...${text.slice(-6)}`;
}

export async function apiGetJson(
  baseUrl,
  endpoint,
  { timeoutMs = 35_000, label = 'GET' } = {},
) {
  const url = new URL(endpoint, ensureBase(baseUrl));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: buildCommonHeaders(),
      signal: controller.signal,
    });
    const rawText = await res.text();
    if (!res.ok) {
      throw new Error(`${label} HTTP ${res.status}: ${rawText.slice(0, 500)}`);
    }
    return JSON.parse(rawText);
  } finally {
    clearTimeout(timer);
  }
}

export async function apiPostJson(
  baseUrl,
  endpoint,
  body,
  { token, timeoutMs = 15_000, label = 'POST' } = {},
) {
  const url = new URL(endpoint, ensureBase(baseUrl));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders({ token }),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const rawText = await res.text();
    if (!res.ok) {
      throw new Error(`${label} HTTP ${res.status}: ${rawText.slice(0, 500)}`);
    }
    return JSON.parse(rawText);
  } finally {
    clearTimeout(timer);
  }
}

function baseInfo() {
  return {
    channel_version: CHANNEL_VERSION,
    bot_agent: BOT_AGENT,
  };
}

export async function fetchQRCode(baseUrl = DEFAULT_BASE_URL, botType = DEFAULT_BOT_TYPE) {
  const resp = await apiPostJson(
    baseUrl,
    `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    { local_token_list: [] },
    { timeoutMs: 15_000, label: 'fetchQRCode' },
  );
  if (!resp?.qrcode) {
    throw new Error(`获取二维码失败: ${JSON.stringify(resp)}`);
  }
  return resp;
}

export async function pollQRStatus(baseUrl, qrcode, verifyCode) {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
  try {
    return await apiGetJson(baseUrl, endpoint, {
      timeoutMs: 35_000,
      label: 'pollQRStatus',
    });
  } catch (err) {
    if (err?.name === 'AbortError') return { status: 'wait' };
    // 服务端网关 5xx 等短暂失败时继续等待，避免整条登录流程直接退出。
    return { status: 'wait' };
  }
}

export async function readVerifyCodeFromStdin(prompt) {
  process.stdout.write(prompt);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for await (const line of rl) {
      const value = line.trim();
      if (value) return value;
      process.stdout.write('请输入微信里显示的数字：');
    }
  } finally {
    rl.close();
  }
  return '';
}

export async function displayQRCode(qrcodeValue) {
  try {
    qrcode.generate(qrcodeValue, { small: true });
    process.stdout.write(`若二维码无法显示，请直接访问：\n${qrcodeValue}\n`);
  } catch {
    process.stdout.write(`请用手机微信扫描或打开：\n${qrcodeValue}\n`);
  }
}

export async function startWeixinLogin({ baseUrl = DEFAULT_BASE_URL, botType = DEFAULT_BOT_TYPE } = {}) {
  const qr = await fetchQRCode(baseUrl, botType);
  return {
    qrcode: qr.qrcode,
    qrcodeUrl: qr.qrcode_img_content || qr.qrcode,
  };
}

export async function waitForWeixinLogin({
  qrcode,
  baseUrl = DEFAULT_BASE_URL,
  botType = DEFAULT_BOT_TYPE,
  timeoutMs = 8 * 60_000,
  maxQRRefresh = 3,
  onQR,
}) {
  const deadline = Date.now() + Math.max(timeoutMs, 1000);
  let currentBaseUrl = baseUrl || DEFAULT_BASE_URL;
  let pendingVerifyCode;
  let refreshCount = 1;
  let scannedPrinted = false;
  let currentQrcode = qrcode;

  while (Date.now() < deadline) {
    const statusResponse = await pollQRStatus(currentBaseUrl, currentQrcode, pendingVerifyCode);
    const status = statusResponse?.status;

    switch (status) {
      case 'wait':
        process.stdout.write('.');
        break;

      case 'scaned':
        if (pendingVerifyCode) pendingVerifyCode = undefined;
        if (!scannedPrinted) {
          process.stdout.write('\n已扫码，正在验证...\n');
          scannedPrinted = true;
        }
        break;

      case 'need_verifycode': {
        const prompt = pendingVerifyCode
          ? '❌ 数字不匹配，请重新输入微信里显示的数字：'
          : '请输入手机微信里显示的数字：';
        pendingVerifyCode = await readVerifyCodeFromStdin(prompt);
        continue;
      }

      case 'scaned_but_redirect':
        if (statusResponse?.redirect_host) {
          currentBaseUrl = `https://${statusResponse.redirect_host}`;
          process.stdout.write(`\n已切换接入节点：${currentBaseUrl}\n`);
        }
        break;

      case 'confirmed': {
        if (!statusResponse?.ilink_bot_id) {
          throw new Error('登录已确认，但服务器未返回 ilink_bot_id。');
        }
        return {
          connected: true,
          botToken: statusResponse.bot_token,
          accountId: statusResponse.ilink_bot_id,
          userId: statusResponse.ilink_user_id,
          baseUrl: normalizeBaseUrl(statusResponse.baseurl),
        };
      }

      case 'binded_redirect':
        throw new Error(
          '这个微信号已经绑定过机器人，但没有本地 token。请删除 state/auth.json 或改用已有 token 后重试。',
        );

      case 'expired':
      case 'verify_code_blocked':
        refreshCount += 1;
        if (refreshCount > maxQRRefresh) {
          throw new Error('二维码多次失效或验证码多次错误，登录流程已停止。');
        }
        process.stdout.write(
          `\n${status === 'expired' ? '二维码已过期' : '验证码多次错误'}，正在刷新二维码（${refreshCount}/${maxQRRefresh}）...\n`,
        );
        try {
          const next = await fetchQRCode(DEFAULT_BASE_URL, botType);
          currentQrcode = next.qrcode;
          const qrUrl = next.qrcode_img_content || next.qrcode;
          await (onQR ? onQR(qrUrl) : displayQRCode(qrUrl));
          scannedPrinted = false;
          pendingVerifyCode = undefined;
        } catch (err) {
          throw new Error(`刷新二维码失败: ${err?.message || err}`);
        }
        break;

      default:
        process.stdout.write('.');
        break;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error('登录超时，请重新运行。');
}

export function normalizeBaseUrl(baseUrl) {
  const value = String(baseUrl || '').trim();
  if (!value) return DEFAULT_BASE_URL;
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
}

export function extractText(msg) {
  const items = Array.isArray(msg?.item_list) ? msg.item_list : [];
  for (const item of items) {
    if (item?.type === 1 && item?.text_item?.text != null) {
      return String(item.text_item.text);
    }
    // 语音转文字内容也当作文本交给 Codex。
    if (item?.type === 3 && item?.voice_item?.text != null) {
      return String(item.voice_item.text);
    }
  }
  return '';
}

export function isUserTextMessage(msg) {
  if (!msg) return false;
  // 忽略自己发出的 BOT 消息。
  if (msg.message_type === 2) return false;
  return extractText(msg).trim().length > 0;
}

export async function sendMessageWeixin({
  baseUrl,
  token,
  toUserId,
  text,
  contextToken,
}) {
  if (!baseUrl || !token) throw new Error('缺少 iLink baseUrl/token。');
  const body = {
    msg: {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: generateClientId(),
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text } }],
      ...(contextToken ? { context_token: contextToken } : {}),
    },
    base_info: baseInfo(),
  };
  const resp = await apiPostJson(baseUrl, 'ilink/bot/sendmessage', body, {
    token,
    timeoutMs: 15_000,
    label: 'sendMessage',
  });
  if (resp?.ret && resp.ret !== 0) {
    throw new Error(`sendMessage ret=${resp.ret} errmsg=${resp.errmsg ?? '(none)'}`);
  }
  return resp;
}

export async function getConfig({
  baseUrl,
  token,
  ilinkUserId,
  contextToken,
}) {
  const resp = await apiPostJson(
    baseUrl,
    'ilink/bot/getconfig',
    {
      ilink_user_id: ilinkUserId,
      ...(contextToken ? { context_token: contextToken } : {}),
      base_info: baseInfo(),
    },
    { token, timeoutMs: 10_000, label: 'getConfig' },
  );
  return resp;
}

export async function sendTyping({
  baseUrl,
  token,
  ilinkUserId,
  typingTicket,
  status = 1,
}) {
  await apiPostJson(
    baseUrl,
    'ilink/bot/sendtyping',
    {
      ilink_user_id: ilinkUserId,
      typing_ticket: typingTicket,
      status,
      base_info: baseInfo(),
    },
    { token, timeoutMs: 10_000, label: 'sendTyping' },
  );
}

export async function getUpdates({
  baseUrl,
  token,
  getUpdatesBuf = '',
  timeoutMs = 35_000,
}) {
  try {
    const resp = await apiPostJson(
      baseUrl,
      'ilink/bot/getupdates',
      {
        get_updates_buf: getUpdatesBuf,
        base_info: baseInfo(),
      },
      { token, timeoutMs, label: 'getUpdates' },
    );
    return resp;
  } catch (err) {
    if (err?.name === 'AbortError') {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw err;
  }
}

function generateClientId() {
  return `openclaw-weixin-${randomBytes(8).toString('hex')}`;
}

export function redactToken(value) {
  return redact(value);
}
