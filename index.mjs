import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, isAbsolute, join } from 'node:path';
import {
  DEFAULT_BASE_URL,
  DEFAULT_BOT_TYPE,
  normalizeBaseUrl,
  startWeixinLogin,
  waitForWeixinLogin,
  displayQRCode,
  getUpdates,
  sendMessageWeixin,
  getConfig,
  sendTyping,
  extractText,
  isUserTextMessage,
} from './ilink.mjs';
import { runCodex } from './codex.mjs';
import { listCodexSessions } from './codex-sessions.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const stateDir = join(here, 'state');
const authFile = join(stateDir, 'auth.json');
const syncFile = join(stateDir, 'sync.json');
const contextTokensFile = join(stateDir, 'context-tokens.json');
const codexSessionsFile = join(stateDir, 'codex-sessions.json');
const seenMessagesFile = join(stateDir, 'seen-messages.json');
const lockFile = join(stateDir, 'bridge.lock');

const config = JSON.parse(readFileSync(join(here, 'config.json'), 'utf8'));

const workdirByUser = new Map();
const running = new Set();
const contextTokens = new Map(Object.entries(loadJson(contextTokensFile, {})));
const typingTickets = new Map();
const codexSessions = loadJson(codexSessionsFile, {});
const seenMessages = new Set(loadJson(seenMessagesFile, []));

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function acquireLock() {
  mkdirSync(stateDir, { recursive: true });
  try {
    writeFileSync(lockFile, String(process.pid), { flag: 'wx', mode: 0o600 });
    return true;
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
    let existingPid = 0;
    try {
      existingPid = Number.parseInt(readFileSync(lockFile, 'utf8').trim(), 10);
    } catch {
      // ignore
    }
    if (!existingPid || !isProcessAlive(existingPid)) {
      try {
        rmSync(lockFile);
      } catch {
        // ignore
      }
      return acquireLock();
    }
    return false;
  }
}

function releaseLock() {
  try {
    rmSync(lockFile);
  } catch {
    // ignore
  }
}

if (!acquireLock()) {
  console.error('检测到 wechat-codex-bridge 已在运行，本次启动退出。请勿同时启动多个实例。');
  process.exit(0);
}

process.on('exit', releaseLock);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    releaseLock();
    process.exit(0);
  });
}

function loadJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function loadAuth() {
  const fromEnv = {
    token: process.env.ILINK_BOT_TOKEN?.trim(),
    baseUrl: process.env.ILINK_BASE_URL?.trim(),
    accountId: process.env.ILINK_BOT_ID?.trim(),
    userId: process.env.ILINK_USER_ID?.trim(),
  };
  if (fromEnv.token) {
    return {
      token: fromEnv.token,
      baseUrl: normalizeBaseUrl(fromEnv.baseUrl),
      accountId: fromEnv.accountId || 'env',
      userId: fromEnv.userId,
    };
  }
  return loadJson(authFile, null);
}

function saveAuth(auth) {
  saveJson(authFile, { ...auth, savedAt: new Date().toISOString() });
}

function loadSyncBuf() {
  return loadJson(syncFile, {})?.get_updates_buf || '';
}

function saveSyncBuf(buf) {
  saveJson(syncFile, { get_updates_buf: buf });
}

function saveContextTokens() {
  saveJson(contextTokensFile, Object.fromEntries(contextTokens));
}

function saveCodexSessions() {
  saveJson(codexSessionsFile, codexSessions);
}

function saveSeenMessages() {
  saveJson(seenMessagesFile, [...seenMessages]);
}

function messageKey(msg) {
  if (!msg) return '';
  return String(msg.message_id ?? msg.client_id ?? msg.seq ?? '');
}

function isDuplicateMessage(msg) {
  const key = messageKey(msg);
  if (!key) return false;
  if (seenMessages.has(key)) return true;
  seenMessages.add(key);
  if (seenMessages.size > 500) {
    const oldest = seenMessages.values().next().value;
    seenMessages.delete(oldest);
  }
  saveSeenMessages();
  return false;
}

function normalizeWorkdir(p) {
  if (!isAbsolute(p)) p = resolve(config.workdir, p);
  const dir = resolve(p);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return { error: `目录不存在或不是目录: ${dir}` };
  }
  if (config.allowedWorkdirs?.length) {
    const ok = config.allowedWorkdirs.some(
      (a) => resolve(a) === dir || dir.startsWith(resolve(a) + '/'),
    );
    if (!ok) return { error: `目录不在白名单内: ${dir}` };
  }
  return { dir };
}

function getWorkdir(userId) {
  return workdirByUser.get(userId) || config.workdir;
}

function isAllowed(userId) {
  if (!config.whitelist?.length) return true;
  return config.whitelist.some((id) => String(id) === String(userId));
}

function chunkText(text, max) {
  const rest = String(text ?? '');
  const limit = Number(max) || 4000;
  const out = [];
  for (let i = 0; i < rest.length; i += limit) {
    out.push(rest.slice(i, i + limit));
  }
  return out.length ? out : [''];
}

function truncateChars(text, max) {
  const chars = Array.from(String(text ?? ''));
  if (chars.length <= max) return String(text ?? '');
  if (max <= 3) return chars.slice(0, max).join('');
  return `${chars.slice(0, max - 3).join('')}...`;
}

async function sendReply(userId, text, contextToken) {
  for (const chunk of chunkText(text, config.replyMaxLength)) {
    if (!chunk.trim()) continue;
    await sendMessageWeixin({
      baseUrl: auth.baseUrl,
      token: auth.token,
      toUserId: userId,
      text: chunk,
      contextToken,
    });
  }
}

async function sendAck(userId, text, workdir, contextToken, resumeDesc) {
  const max = Math.min(Number(config.replyMaxLength) || 4000, 4000);
  const head = '已收到提问：\n';
  const tail = `\n\nCodex 开始执行（工作目录: ${workdir}${resumeDesc}）...`;
  const budget = max - Array.from(head).length - Array.from(tail).length;
  const ack = head + truncateChars(text, Math.max(budget, 0)) + tail;
  try {
    await sendMessageWeixin({
      baseUrl: auth.baseUrl,
      token: auth.token,
      toUserId: userId,
      text: ack,
      contextToken,
    });
  } catch (err) {
    // 确认消息失败不影响 Codex 执行；任务仍只运行一次。
    console.error(`[weixin] 发送确认消息失败: ${err?.message || err}`);
  }
}

function helpText() {
  return [
    'Codex 微信桥接机器人（iLink 个人微信协议）',
    '',
    '直接发消息 -> 交给 Codex 执行并回复结果',
    '/cd <目录>  -> 设置当前用户的工作目录',
    '/workdir    -> 查看当前工作目录',
    '/history [n] -> 列出最近的 Codex 会话',
    '/resume <会话ID|last> -> 加载指定历史会话',
    '/session    -> 查看当前会话',
    '/new        -> 开始新会话',
    '/help       -> 显示本帮助',
    '',
    '模型 / 沙盒 / 权限均继承 ~/.codex/config.toml 的当前配置。',
  ].join('\n');
}

async function ensureLogin() {
  let current = loadAuth();
  if (current?.token) return current;

  process.stdout.write('未找到 iLink token，开始二维码登录...\n');
  const started = await startWeixinLogin({
    baseUrl: DEFAULT_BASE_URL,
    botType: process.env.ILINK_BOT_TYPE || DEFAULT_BOT_TYPE,
  });
  await displayQRCode(started.qrcodeUrl);

  const result = await waitForWeixinLogin({
    qrcode: started.qrcode,
    baseUrl: DEFAULT_BASE_URL,
    botType: process.env.ILINK_BOT_TYPE || DEFAULT_BOT_TYPE,
    onQR: displayQRCode,
  });

  if (!result.connected || !result.botToken) {
    throw new Error(result?.message || '登录失败，未返回 bot_token。');
  }

  current = {
    token: result.botToken,
    baseUrl: normalizeBaseUrl(result.baseUrl),
    accountId: result.accountId,
    userId: result.userId,
  };
  saveAuth(current);
  process.stdout.write(
    `登录成功。accountId=${result.accountId} userId=${result.userId ?? '(未知)'}\n`,
  );
  return current;
}

async function getTypingTicket(userId, contextToken) {
  if (typingTickets.has(userId)) return typingTickets.get(userId);
  try {
    const resp = await getConfig({
      baseUrl: auth.baseUrl,
      token: auth.token,
      ilinkUserId: userId,
      contextToken,
    });
    if (resp?.ret === 0 && resp?.typing_ticket) {
      typingTickets.set(userId, resp.typing_ticket);
      return resp.typing_ticket;
    }
  } catch {
    // 打字指示只是锦上添花，失败不阻断。
  }
  return '';
}

async function setTyping(userId, contextToken, status) {
  try {
    const ticket = await getTypingTicket(userId, contextToken);
    if (!ticket) return;
    await sendTyping({
      baseUrl: auth.baseUrl,
      token: auth.token,
      ilinkUserId: userId,
      typingTicket: ticket,
      status,
    });
  } catch {
    // ignore
  }
}

async function handleMessage(msg) {
  const userId = String(msg.from_user_id || '');
  const text = extractText(msg).trim();
  if (!userId || !text || !isAllowed(userId)) return;
  if (isDuplicateMessage(msg)) return;

  const incomingContextToken = msg.context_token;
  if (incomingContextToken) {
    contextTokens.set(userId, incomingContextToken);
    saveContextTokens();
  }
  const contextToken = incomingContextToken || contextTokens.get(userId);

  if (text === '/help' || text === 'help') {
    await sendReply(userId, helpText(), contextToken);
    return;
  }
  if (text === '/workdir' || text === 'workdir') {
    await sendReply(userId, `当前工作目录: ${getWorkdir(userId)}`, contextToken);
    return;
  }
  if (text === '/cd' || text === 'cd') {
    await sendReply(userId, '用法: /cd <绝对或相对目录>', contextToken);
    return;
  }
  if (text.startsWith('/cd ') || text.startsWith('cd ')) {
    const target = text.replace(/^\/?cd\s+/, '').trim();
    const r = normalizeWorkdir(target);
    if (r.error) {
      await sendReply(userId, r.error, contextToken);
    } else {
      workdirByUser.set(userId, r.dir);
      await sendReply(userId, `工作目录已设置为: ${r.dir}`, contextToken);
    }
    return;
  }

  if (text === '/history' || text.startsWith('/history ')) {
    const arg = text.replace(/^\/history(?:\s+)/, '').trim();
    const limit = Number.parseInt(arg, 10);
    const count = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 20) : 5;
    try {
      const sessions = await listCodexSessions({ limit: count, workdir: getWorkdir(userId) });
      if (!sessions.length) {
        await sendReply(userId, '当前工作目录下没有找到 Codex 历史会话。', contextToken);
      } else {
        const lines = sessions.map((s, i) => {
          const time = s.timestamp
            ? new Date(s.timestamp).toLocaleString('zh-CN', { hour12: false })
            : '';
          return `${i + 1}. ${s.sessionId}\n   目录: ${s.cwd || '(未知)'}${time ? `\n   时间: ${time}` : ''}`;
        });
        await sendReply(userId, `最近的 Codex 会话：\n\n${lines.join('\n\n')}`, contextToken);
      }
    } catch (err) {
      await sendReply(userId, `读取历史会话失败: ${err?.message || err}`, contextToken);
    }
    return;
  }

  if (text === '/session' || text === 'session') {
    const current = codexSessions[userId];
    await sendReply(
      userId,
      current
        ? `当前会话: ${current}\n（之后的普通消息会继续这个会话；/new 开始新会话）`
        : '当前没有绑定历史会话，普通消息会创建新会话。',
      contextToken,
    );
    return;
  }

  if (text === '/new' || text === 'new') {
    delete codexSessions[userId];
    saveCodexSessions();
    await sendReply(userId, '已切换到新会话。下一条消息会创建新的 Codex 会话。', contextToken);
    return;
  }

  if (text.startsWith('/resume ') || text.startsWith('resume ')) {
    const id = text.replace(/^\/?resume\s+/, '').trim();
    if (!id) {
      await sendReply(userId, '用法: /resume <会话ID|last>', contextToken);
    } else {
      codexSessions[userId] = id === 'last' ? 'last' : id;
      saveCodexSessions();
      await sendReply(
        userId,
        id === 'last'
          ? '已设置为加载最近一次 Codex 会话。'
          : `已设置加载历史会话: ${id}。之后的普通消息会继续该会话；/new 开始新会话。`,
        contextToken,
      );
    }
    return;
  }

  if (running.has(userId)) {
    await sendReply(userId, '上一个任务仍在执行，请稍候。', contextToken);
    return;
  }

  const workdir = getWorkdir(userId);
  const savedSession = codexSessions[userId];
  const resumeLast = savedSession === 'last';
  const resumeSessionId = !resumeLast && savedSession ? savedSession : undefined;
  running.add(userId);
  const resumeDesc = resumeLast
    ? '，恢复最近会话'
    : resumeSessionId
      ? `，恢复会话 ${resumeSessionId}`
      : '，新会话';
  await sendAck(userId, text, workdir, contextToken, resumeDesc);

  try {
    await setTyping(userId, contextToken, 1);
    const { text: result, sessionId } = await runCodex({
      prompt: text,
      workdir,
      autoApprove: !!config.autoApprove,
      skipGitRepoCheck: config.skipGitRepoCheck !== false,
      sandboxMode: config.sandboxMode,
      networkAccess: config.networkAccess !== false,
      resumeSessionId,
      resumeLast,
      onProgress: (partial) => {
        if (process.env.CODEX_WECHAT_DEBUG) {
          console.log(`[progress ${userId}] ${String(partial).slice(-160)}`);
        }
      },
    });
    if (sessionId) {
      codexSessions[userId] = sessionId;
      saveCodexSessions();
    }
    await setTyping(userId, contextToken, 2);
    const final = result?.trim() || '（Codex 未返回文本）';
    await sendReply(userId, final, contextToken);
  } catch (err) {
    await setTyping(userId, contextToken, 2);
    const errorText = String(err?.message || err);
    const writerConflict = /already has an active writer|thread-store conflict/i.test(errorText);
    if (writerConflict && (resumeSessionId || resumeLast)) {
      delete codexSessions[userId];
      saveCodexSessions();
      try {
        const fallback = await runCodex({
          prompt: text,
          workdir,
          autoApprove: !!config.autoApprove,
          skipGitRepoCheck: config.skipGitRepoCheck !== false,
          sandboxMode: config.sandboxMode,
          networkAccess: config.networkAccess !== false,
        });
        if (fallback.sessionId) {
          codexSessions[userId] = fallback.sessionId;
          saveCodexSessions();
        }
        const final = fallback.text?.trim() || '（Codex 未返回文本）';
        await sendReply(
          userId,
          `⚠️ 原历史会话正被另一个 Codex 进程占用，已自动改用新会话：\n\n${final}`,
          contextToken,
        );
      } catch (fallbackErr) {
        await sendReply(userId, `执行出错: ${fallbackErr?.message || fallbackErr}`, contextToken);
      }
    } else {
      await sendReply(userId, `执行出错: ${errorText}`, contextToken);
    }
  } finally {
    running.delete(userId);
  }
}

async function pollLoop() {
  let getUpdatesBuf = loadSyncBuf();
  let longPollTimeoutMs = 35_000;
  let consecutiveFailures = 0;

  while (true) {
    let resp;
    try {
      resp = await getUpdates({
        baseUrl: auth.baseUrl,
        token: auth.token,
        getUpdatesBuf,
        timeoutMs: longPollTimeoutMs,
      });
    } catch (err) {
      consecutiveFailures += 1;
      console.error(
        `[weixin] getUpdates 网络错误（${consecutiveFailures}/3）: ${err?.message || err}`,
      );
      if (consecutiveFailures >= 3) {
        await sleep(30_000);
        consecutiveFailures = 0;
      } else {
        await sleep(2_000);
      }
      continue;
    }

    const apiError =
      (resp?.ret !== undefined && resp.ret !== 0) ||
      (resp?.errcode !== undefined && resp.errcode !== 0);
    if (apiError) {
      consecutiveFailures += 1;
      console.error(
        `[weixin] getUpdates API 错误: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ''}`,
      );
      if (resp.errcode === -14 || resp.ret === -14) {
        console.error('[weixin] token 已失效，需要重新扫码登录。');
        auth = await relogin();
        getUpdatesBuf = '';
        saveSyncBuf('');
        contextTokens.clear();
        saveContextTokens();
        typingTickets.clear();
        consecutiveFailures = 0;
      } else {
        if (consecutiveFailures >= 3) {
          await sleep(30_000);
          consecutiveFailures = 0;
        } else {
          await sleep(2_000);
        }
      }
      continue;
    }

    consecutiveFailures = 0;
    if (resp?.longpolling_timeout_ms) {
      longPollTimeoutMs = Number(resp.longpolling_timeout_ms);
    }
    if (typeof resp?.get_updates_buf === 'string' && resp.get_updates_buf) {
      getUpdatesBuf = resp.get_updates_buf;
      saveSyncBuf(getUpdatesBuf);
    }

    for (const msg of resp?.msgs || []) {
      if (isUserTextMessage(msg)) {
        await handleMessage(msg).catch((err) => {
          console.error(`[weixin] 处理消息失败: ${err?.stack || err}`);
        });
      }
    }
  }
}

async function relogin() {
  process.stdout.write('\n请重新扫描二维码登录微信机器人...\n');
  const started = await startWeixinLogin({
    baseUrl: DEFAULT_BASE_URL,
    botType: process.env.ILINK_BOT_TYPE || DEFAULT_BOT_TYPE,
  });
  await displayQRCode(started.qrcodeUrl);
  const result = await waitForWeixinLogin({
    qrcode: started.qrcode,
    baseUrl: DEFAULT_BASE_URL,
    botType: process.env.ILINK_BOT_TYPE || DEFAULT_BOT_TYPE,
    onQR: displayQRCode,
  });
  if (!result.connected || !result.botToken) {
    throw new Error(result?.message || '重新登录失败。');
  }
  const next = {
    token: result.botToken,
    baseUrl: normalizeBaseUrl(result.baseUrl),
    accountId: result.accountId,
    userId: result.userId,
  };
  saveAuth(next);
  return next;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let auth = loadAuth();

auth = await ensureLogin();

process.stdout.write(
  `已启动。accountId=${auth.accountId} userId=${auth.userId ?? '(未知)'} ` +
    `baseUrl=${auth.baseUrl}\n模型/沙盒/权限继承当前 Codex 配置，workdir=${config.workdir}\n`,
);

pollLoop().catch((err) => {
  console.error('主循环退出:', err);
  process.exit(1);
});
