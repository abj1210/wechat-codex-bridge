import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, isAbsolute, join, relative } from 'node:path';
import spawn from 'cross-spawn';
import { randomUUID } from 'node:crypto';
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
const currentProcesses = new Map();
const interruptedUsers = new Set();
const userQueues = new Map();
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
      (a) => {
        const root = resolve(a);
        const rel = relative(root, dir);
        return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
      },
    );
    if (!ok) return { error: `目录不在白名单内: ${dir}` };
  }
  return { dir };
}

function getWorkdir(userId) {
  return resolve(workdirByUser.get(userId) || config.workdir);
}

function pythonStateValue(userId, map) {
  if (!map) return undefined;
  const bare = String(userId).replace(/@im\.wechat$/, '');
  return map[userId] ?? map[`${bare}@im.wechat`] ?? map[bare];
}

function pythonWorkdirFor(userId) {
  const state = loadJson(join(here, 'packages', 'workdir', 'state.json'), {});
  const stored = pythonStateValue(userId, state?.user_workdirs);
  return stored ? resolve(stored) : resolve(config.workdir || '.', here);
}

function pythonSessionLabel(userId) {
  const state = loadJson(join(here, 'packages', 'sessions', 'state.json'), {});
  const sessionId = pythonStateValue(userId, state?.user_sessions);
  if (!sessionId) return '新会话';
  if (sessionId === 'last') return '最近会话';
  const name = pythonStateValue(userId, state?.user_session_names);
  return name || sessionId;
}

function isWorkPaused() {
  return !!loadJson(join(here, 'packages', 'control', 'state.json'), {})?.paused;
}

function bufferedRepliesPath(userId) {
  const safe = Buffer.from(String(userId)).toString('base64url');
  return join(stateDir, 'buffered-replies', `${safe}.json`);
}

function appendBufferedReply(userId, text) {
  const file = bufferedRepliesPath(userId);
  const list = loadJson(file, []);
  list.push(text);
  saveJson(file, list);
}

async function flushBufferedReplies(userId, contextToken) {
  const file = bufferedRepliesPath(userId);
  const list = loadJson(file, []);
  for (const text of list) {
    await sendReply(userId, text, contextToken);
  }
  if (list.length) saveJson(file, []);
}

async function interruptCurrentTask(userId, contextToken) {
  const entry = currentProcesses.get(userId);
  if (!entry) {
    await sendReply(userId, '当前没有正在运行的任务。', contextToken);
    return;
  }
  const stopFile = join(here, 'runtime', entry.runId, 'stop.flag');
  mkdirSync(dirname(stopFile), { recursive: true });
  writeFileSync(stopFile, JSON.stringify({ stopped_at: Date.now() }));
  await sendReply(userId, '已打断当前任务。', contextToken);
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

function loginBaseUrl() {
  const envBase = process.env.ILINK_BASE_URL?.trim();
  return envBase ? normalizeBaseUrl(envBase) : DEFAULT_BASE_URL;
}

async function ensureLogin() {
  let current = loadAuth();
  if (current?.token) return current;

  const baseUrl = loginBaseUrl();
  process.stdout.write('未找到 iLink token，开始二维码登录...\n');
  const started = await startWeixinLogin({
    baseUrl,
    botType: process.env.ILINK_BOT_TYPE || DEFAULT_BOT_TYPE,
  });
  await displayQRCode(started.qrcodeUrl);

  const result = await waitForWeixinLogin({
    qrcode: started.qrcode,
    baseUrl,
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

function runPythonHook(script, input, workdir, timeoutMs = 60_000, extraEnv = {}) {
  return new Promise((resolveHook, rejectHook) => {
    const child = spawn('python3', [script], {
      cwd: workdir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CODEX_BRIDGE_WORKDIR: workdir,
        ...extraEnv,
      },
      detached: process.platform !== 'win32',
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      killProcessTree(child);
      rejectHook(new Error(`Python 钩子超时: ${script}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      rejectHook(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolveHook(stdout.trim());
      } else {
        rejectHook(new Error(stderr.trim() || `Python 钩子退出码 ${code}`));
      }
    });

    child.stdin.end(input ?? '');
  });
}

function killProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    } catch {
      // ignore
    }
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
}

function heartbeatMtime(runId) {
  try {
    return statSync(join(here, 'runtime', runId, 'heartbeat.json')).mtimeMs;
  } catch {
    return 0;
  }
}

function runPythonBackend(text, workdir, userId, runId) {
  return new Promise((resolveBackend, rejectBackend) => {
    const child = spawn('python3', [config.pythonHandler], {
      cwd: here,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CODEX_BRIDGE_PROJECT_ROOT: here,
        CODEX_BRIDGE_WORKDIR: workdir,
        CODEX_BRIDGE_USER_ID: userId,
        CODEX_BRIDGE_MODE: 'wechat',
        CODEX_BRIDGE_RUN_ID: runId,
      },
      detached: process.platform !== 'win32',
    });
    currentProcesses.set(userId, { child, runId });

    let stdout = '';
    let stderr = '';
    const timeoutMs = Number(config.pythonHandlerTimeoutMs) || 30 * 60_000;
    let lastHeartbeat = Date.now();
    const watchdog = setInterval(() => {
      const mtime = heartbeatMtime(runId);
      if (mtime) lastHeartbeat = mtime;
      if (Date.now() - lastHeartbeat > timeoutMs) {
        clearInterval(watchdog);
        killProcessTree(child);
        const err = new Error(`Python 处理程序超时: ${config.pythonHandler}`);
        err.code = 'PYTHON_HANDLER_TIMEOUT';
        rejectBackend(err);
      }
    }, 10_000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearInterval(watchdog);
      currentProcesses.delete(userId);
      rejectBackend(err);
    });
    child.on('close', (code) => {
      clearInterval(watchdog);
      currentProcesses.delete(userId);
      try {
        const parsed = JSON.parse(stdout.trim());
        resolveBackend(parsed);
      } catch {
        rejectBackend(
          new Error(stderr.trim() || stdout.trim() || `Python 处理程序退出码 ${code}`),
        );
      }
    });

    child.stdin.end(text ?? '');
  });
}

async function handlePythonBackendMessage(userId, text, contextToken) {
  if (running.has(userId)) {
    await sendReply(userId, '上一个任务仍在执行，请稍候。', contextToken);
    return;
  }
  if (isWorkPaused() && !text.startsWith('/')) {
    await sendReply(userId, '当前工作已暂停，发送 /continue 恢复。', contextToken);
    return;
  }

  running.add(userId);
  const workdir = pythonWorkdirFor(userId);
  const sessionDesc = `，会话：${pythonSessionLabel(userId)}`;
  const runId = randomUUID();
  await sendAck(userId, text, workdir, contextToken, sessionDesc);

  let progressTimer;
  if (config.progressReplies !== false) {
    const configuredMinutes = Number(config.heartbeatMinutes);
    const hasHeartbeatSetting = Number.isFinite(configuredMinutes) && configuredMinutes >= 0;
    const silent = hasHeartbeatSetting && configuredMinutes === 0;
    const interval = hasHeartbeatSetting
      ? Math.max(configuredMinutes || 10, 0) * 60_000 || 600_000
      : Number(config.progressIntervalMs) || 600_000;
    const startedAt = Date.now();
    progressTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const progress = loadJson(join(here, 'runtime', runId, 'progress.json'), null);
      const stage = progress?.detail || progress?.stage || '处理中';
      const heartbeatDir = join(here, 'runtime', runId);
      mkdirSync(heartbeatDir, { recursive: true });
      writeFileSync(
        join(heartbeatDir, 'heartbeat.json'),
        JSON.stringify({ updated_at: Date.now() }),
      );
      if (!silent && !isWorkPaused()) {
        sendReply(
          userId,
          `Codex 仍在处理中，已运行 ${elapsed} 秒\n当前阶段：${stage}`,
          contextToken,
        ).catch((progressErr) => {
          console.error(`[weixin] 发送进度消息失败: ${progressErr?.message || progressErr}`);
        });
      }
    }, interval);
  }

  try {
    await setTyping(userId, contextToken, 1);
    const result = await runPythonBackend(text, workdir, userId, runId);
    await setTyping(userId, contextToken, 2);
    if (result?.status === 'timeout') {
      await sendReply(userId, '执行超时，服务即将重启以清理残留进程。', contextToken);
      scheduleServiceReset();
      return;
    }
    const final = result?.text?.trim() || '（Python 处理程序未返回文本）';
    if (isWorkPaused()) {
      appendBufferedReply(userId, final);
    } else {
      await sendReply(userId, final, contextToken);
    }
  } catch (err) {
    await setTyping(userId, contextToken, 2);
    if (interruptedUsers.has(userId)) {
      interruptedUsers.delete(userId);
    } else if (err?.code === 'PYTHON_HANDLER_TIMEOUT') {
      await sendReply(userId, '执行超时，服务即将重启以清理残留进程。', contextToken);
      scheduleServiceReset();
    } else {
      await sendReply(userId, `执行出错: ${err?.message || err}`, contextToken);
    }
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    running.delete(userId);
  }
}

function scheduleServiceReset() {
  console.error('[weixin] Codex 处理超时，已清理进程树，准备重启服务。');
  setTimeout(() => {
    process.exit(1);
  }, 1500);
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

  if (config.backend === 'python' && text === '/continue') {
    await flushBufferedReplies(userId, contextToken);
  }

  if (config.backend === 'python' && text === '/stop') {
    await interruptCurrentTask(userId, contextToken);
    return;
  }

  if (config.backend === 'python' && config.pythonHandler) {
    await handlePythonBackendMessage(userId, text, contextToken);
    return;
  }

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
  let promptText = text;
  if (config.pythonPreprocess) {
    try {
      const processed = await runPythonHook(config.pythonPreprocess, text, workdir);
      if (processed) promptText = processed;
    } catch (err) {
      console.error(`[weixin] Python 预处理失败: ${err?.message || err}`);
    }
  }
  running.add(userId);
  const resumeDesc = resumeLast
    ? '，恢复最近会话'
    : resumeSessionId
      ? `，恢复会话 ${resumeSessionId}`
      : '，新会话';
  await sendAck(userId, text, workdir, contextToken, resumeDesc);

  try {
    await setTyping(userId, contextToken, 1);
    let final;
    if (config.pythonHandler) {
      const handlerTimeout = Number(config.pythonHandlerTimeoutMs) || 30 * 60_000;
      final = await runPythonHook(
        config.pythonHandler,
        promptText,
        workdir,
        handlerTimeout,
        { CODEX_BRIDGE_USER_ID: userId },
      );
      if (!final) final = '（Python 处理程序未返回文本）';
    } else {
      const { text: result, sessionId } = await runCodex({
        prompt: promptText,
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
      final = result?.trim() || '（Codex 未返回文本）';
      if (config.pythonPostprocess) {
        try {
          const processed = await runPythonHook(config.pythonPostprocess, final, workdir);
          if (processed) final = processed;
        } catch (err) {
          console.error(`[weixin] Python 后处理失败: ${err?.message || err}`);
        }
      }
    }
    await setTyping(userId, contextToken, 2);
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
          prompt: promptText,
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

function enqueueMessage(msg) {
  const userId = String(msg.from_user_id || '');
  if (!userId || !isUserTextMessage(msg)) return;

  const previous = userQueues.get(userId) || Promise.resolve();
  const task = previous.catch(() => {}).then(() => handleMessage(msg));
  userQueues.set(userId, task);
  task
    .catch((err) => {
      console.error(`[weixin] 处理消息失败: ${err?.stack || err}`);
    })
    .finally(() => {
      if (userQueues.get(userId) === task) {
        userQueues.delete(userId);
      }
    });
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
        enqueueMessage(msg);
      }
    }
  }
}

async function relogin() {
  const baseUrl = loginBaseUrl();
  process.stdout.write('\n请重新扫描二维码登录微信机器人...\n');
  const started = await startWeixinLogin({
    baseUrl,
    botType: process.env.ILINK_BOT_TYPE || DEFAULT_BOT_TYPE,
  });
  await displayQRCode(started.qrcodeUrl);
  const result = await waitForWeixinLogin({
    qrcode: started.qrcode,
    baseUrl,
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

if (!config.whitelist?.length) {
  console.warn(
    '[安全提示] config.whitelist 为空，任何能私聊到机器人的微信号都可触发 Codex。建议填写登录后日志中的 userId。',
  );
}

pollLoop().catch((err) => {
  console.error('主循环退出:', err);
  process.exit(1);
});
