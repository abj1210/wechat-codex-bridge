import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * 宽松解析 codex exec --json 的一行事件。
 * 不同版本事件格式不同（旧版 {method,params}、新版 {type,...}），
 * 这里只做尽力提取，最终文本以 --output-last-message 文件为准。
 */
export function parseCodexEventLine(line) {
  if (!line || !line.trim()) return null;
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (!ev || typeof ev !== 'object') return null;

  const s = JSON.stringify(ev);

  // 新版 {type:"error", message:...}
  if (ev.type === 'error' && typeof ev.message === 'string') {
    return { kind: 'error', message: ev.message };
  }

  // 新版 {type:"thread.started", thread_id:...}
  if (ev.type === 'thread.started' && typeof ev.thread_id === 'string') {
    return { kind: 'session', id: ev.thread_id };
  }
  if (ev.type === 'session_meta' && typeof ev.payload?.session_id === 'string') {
    return { kind: 'session', id: ev.payload.session_id };
  }
  if (typeof ev.session_id === 'string' && ev.session_id) {
    return { kind: 'session', id: ev.session_id };
  }

  // 旧版 {method:"item/agentMessage/delta", params:{delta:...}}
  if (ev.method === 'item/agentMessage/delta' && typeof ev.params?.delta === 'string') {
    return { kind: 'delta', text: ev.params.delta };
  }
  // 新版 agent_message_content_delta
  if (/agent_message.*delta/.test(ev.type || '') && typeof ev.delta === 'string') {
    return { kind: 'delta', text: ev.delta };
  }

  // 新版 {type:"item.completed", item:{type:"agent_message", text:...}}
  if (ev.type === 'item.completed' && typeof ev.item?.text === 'string') {
    return { kind: 'final', text: ev.item.text };
  }
  // 旧版 {method:"item/completed", params:{item:{type:"agentMessage",text:...}}}
  if (ev.method === 'item/completed' && typeof ev.params?.item?.text === 'string') {
    return { kind: 'final', text: ev.params.item.text };
  }
  // 新版 item_completed / turn_completed 的 last_agent_message
  if (typeof ev.last_agent_message === 'string') {
    return { kind: 'final', text: ev.last_agent_message };
  }
  if (typeof ev.last_agent_messag === 'string') {
    return { kind: 'final', text: ev.last_agent_messag };
  }

  // 兼容旧版 turn/completed 状态
  if (ev.method === 'turn/completed' && typeof ev.params?.turn?.status === 'string') {
    return { kind: 'turnStatus', status: ev.params.turn.status };
  }
  if ((ev.type === 'turn_completed' || ev.type === 'turn.completed') && typeof ev.status === 'string') {
    return { kind: 'turnStatus', status: ev.status };
  }

  // 兜底：任何带 text 字段的事件（谨慎，避免把无关 text 当结果）
  if (s.length < 20000 && typeof ev.text === 'string' && ev.text.length > 0) {
    return { kind: 'maybe', text: ev.text };
  }
  return null;
}

/**
 * 通过子进程调用本机 codex exec，继承当前 ~/.codex/config.toml 的
 * 模型 / 沙盒 / 权限配置。这里只显式指定工作目录与 JSON 输出，
 * 不传 -m / -s / 审批旁路参数。
 */
export function runCodex({
  prompt,
  workdir,
  autoApprove = false,
  skipGitRepoCheck = true,
  onProgress,
  timeoutMs = 30 * 60 * 1000,
  resumeSessionId,
  resumeLast = false,
}) {
  return new Promise((resolve, reject) => {
    if (!existsSync(workdir)) {
      reject(new Error(`工作目录不存在: ${workdir}`));
      return;
    }

    const lastMsgFile = join(tmpdir(), `codex-wechat-${randomUUID()}.txt`);
    const isResume = Boolean(resumeSessionId || resumeLast);
    let args;
    if (isResume) {
      // codex exec resume 不接受 -C / --color / --full-auto；工作目录通过子进程 cwd 传入，
      // 模型、沙盒、权限继续继承当前 ~/.codex/config.toml。
      args = ['exec', 'resume'];
      if (resumeLast) {
        args.push('--last');
      } else {
        args.push(resumeSessionId);
      }
      args.push('--json');
    } else {
      args = ['exec', '--json', '--color', 'never', '-C', workdir];
    }
    args.push('-o', lastMsgFile);
    if (skipGitRepoCheck) {
      // 仅跳过「必须是 git 仓库」检查，不改变模型 / 沙盒 / 权限。
      args.push('--skip-git-repo-check');
    }
    if (autoApprove && !isResume) {
      // 默认关闭。只有配置显式开启时才自动批准（workspace-write 沙箱）。
      args.push('--full-auto');
    }
    if (!isResume) args.push('--');
    args.push(prompt);

    const child = spawn('codex', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      cwd: workdir,
    });

    let acc = '';
    let sawAgentMessage = false;
    let sessionId = '';
    let settled = false;
    const finish = (fn, val) => {
      if (!settled) {
        settled = true;
        fn(val);
      }
    };

    let stdoutBuf = '';
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        const ev = parseCodexEventLine(line);
        if (!ev) continue;
        if (ev.kind === 'session') {
          sessionId = ev.id;
        } else if (ev.kind === 'delta') {
          sawAgentMessage = true;
          acc += ev.text;
          if (onProgress) onProgress(acc);
        } else if (ev.kind === 'final') {
          sawAgentMessage = true;
          acc = ev.text; // 权威最终文本
        } else if (ev.kind === 'error') {
          // 记录但继续等待，codex 可能自行重连
          if (process.env.CODEX_WECHAT_DEBUG) console.error('[codex]', ev.message);
        } else if (ev.kind === 'turnStatus' && ev.status === 'completed') {
          finish(resolve, { text: acc, sawAgentMessage, sessionId });
        }
      }
    });

    let stderrBuf = '';
    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(reject, new Error(`Codex 任务超时（${timeoutMs}ms）`));
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      finish(reject, err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (code === 0) {
        // 最终结果优先读 --output-last-message 文件，避免依赖事件格式。
        let finalText = acc;
        try {
          if (existsSync(lastMsgFile)) {
            finalText = readFileSync(lastMsgFile, 'utf8');
            sawAgentMessage = finalText.trim().length > 0;
          }
        } catch {
          /* 保留流式累加结果 */
        }
        try {
          unlinkSync(lastMsgFile);
        } catch {
          /* ignore */
        }
        finish(resolve, { text: finalText, sawAgentMessage, sessionId });
      } else {
        const detail = stderrBuf.trim() || `退出码 ${code}`;
        finish(reject, new Error(`Codex 执行失败: ${detail}`));
      }
    });
  });
}
