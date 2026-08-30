import { createReadStream, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

function sessionRoot() {
  return join(homedir(), '.codex', 'sessions');
}

function walkSessionFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkSessionFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

function readFirstJsonLine(file) {
  return new Promise((resolveLine) => {
    let stream;
    try {
      stream = createReadStream(file, { encoding: 'utf8' });
    } catch {
      resolveLine(null);
      return;
    }

    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      try {
        rl.close();
      } catch {
        // ignore
      }
      resolveLine(value);
    };

    rl.on('line', (line) => {
      settle(line);
    });
    rl.on('close', () => settle(null));
    rl.on('error', () => settle(null));
  });
}

function parseSessionMeta(line) {
  if (!line) return null;
  try {
    const ev = JSON.parse(line);
    if (ev?.type === 'session_meta') {
      return {
        sessionId: ev.payload?.session_id || ev.payload?.id,
        cwd: ev.payload?.cwd,
        timestamp: ev.payload?.timestamp || ev.timestamp,
      };
    }
    if (ev?.type === 'thread.started' && ev?.thread_id) {
      return { sessionId: ev.thread_id, cwd: undefined, timestamp: undefined };
    }
  } catch {
    // ignore
  }
  return null;
}

export async function listCodexSessions({ limit = 10, workdir } = {}) {
  const root = sessionRoot();
  const files = walkSessionFiles(root)
    .map((file) => {
      try {
        return { file, mtimeMs: statSync(file).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const results = [];
  for (const { file } of files) {
    if (results.length >= limit) break;
    const meta = parseSessionMeta(await readFirstJsonLine(file));
    if (!meta?.sessionId) continue;
    if (workdir && meta.cwd && resolve(meta.cwd) !== resolve(workdir)) continue;
    results.push({
      sessionId: meta.sessionId,
      cwd: meta.cwd || '',
      timestamp: meta.timestamp || '',
    });
  }
  return results;
}
