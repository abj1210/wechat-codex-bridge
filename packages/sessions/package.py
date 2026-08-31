from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from shared.protocol import PROJECT_ROOT, load_json, save_json

PACKAGE_INFO = {
    "name": "sessions",
    "commands": ["/session", "/resume", "/new", "/history", "/rename"],
    "help": {
        "/session": "查看当前会话",
        "/resume <id|last>": "加载指定历史会话",
        "/new": "开始新会话",
        "/history [n]": "列出最近的 Codex 会话",
        "/rename <名称>": "重命名当前会话",
    },
    "usage": {
        "/session": "/session",
        "/resume": "/resume <会话ID|last>",
        "/new": "/new",
        "/history": "/history [数量]",
        "/rename": "/rename <新名称>",
    },
}

STATE_PATH = PROJECT_ROOT / "packages" / "sessions" / "state.json"


def help(command: str) -> str:
    return PACKAGE_INFO.get("usage", {}).get(command, command)


def _state() -> dict[str, Any]:
    return load_json(STATE_PATH, {"user_sessions": {}, "user_session_names": {}})


def get_session(user_id: str) -> str | None:
    return _state().get("user_sessions", {}).get(user_id)


def get_session_name(user_id: str) -> str | None:
    return _state().get("user_session_names", {}).get(user_id)


def set_session_name(user_id: str, name: str) -> None:
    state = _state()
    names = state.setdefault("user_session_names", {})
    names[user_id] = name
    save_json(STATE_PATH, state)


def set_session(
    user_id: str,
    session_id: str | None,
    name: str | None = None,
    *,
    force_name: bool = False,
) -> None:
    state = _state()
    sessions = state.setdefault("user_sessions", {})
    names = state.setdefault("user_session_names", {})
    if session_id:
        sessions[user_id] = session_id
        if name and (force_name or user_id not in names):
            names[user_id] = name
    else:
        sessions.pop(user_id, None)
        names.pop(user_id, None)
    save_json(STATE_PATH, state)


def _list_history(limit: int = 5) -> list[dict[str, Any]]:
    root = Path.home() / ".codex" / "sessions"
    if not root.exists():
        return []
    files = sorted(root.rglob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
    out = []
    for file in files:
        if len(out) >= limit:
            break
        try:
            with open(file, "r", encoding="utf-8") as f:
                first = f.readline()
            ev = json.loads(first)
            payload = ev.get("payload", {})
            session_id = payload.get("session_id") or payload.get("id")
            if not session_id:
                continue
            out.append(
                {
                    "session_id": session_id,
                    "cwd": payload.get("cwd", ""),
                    "timestamp": payload.get("timestamp", ""),
                }
            )
        except Exception:
            continue
    return out


def process_input(command: str, context: dict[str, Any]) -> dict[str, Any]:
    user_id = str(context.get("user_id", ""))
    parts = command.split(maxsplit=1)
    name = parts[0]
    arg = parts[1].strip() if len(parts) > 1 else ""

    if name == "/session":
        current = get_session(user_id)
        text = current or "当前没有绑定历史会话"
        return {"action": "output", "input": text, "error": ""}

    if name == "/new":
        set_session(user_id, None)
        return {"action": "output", "input": "已切换到新会话", "error": ""}

    if name == "/resume":
        if not arg:
            return {"action": "error", "input": "", "error": "用法: /resume <id|last>"}
        set_session(user_id, arg)
        return {"action": "output", "input": f"已设置历史会话: {arg}", "error": ""}

    if name == "/rename":
        if not arg:
            return {"action": "error", "input": "", "error": "用法: /rename <新名称>"}
        if not get_session(user_id):
            return {"action": "error", "input": "", "error": "当前没有可重命名的会话"}
        new_name = arg.strip().replace("\n", " ")[:60]
        set_session_name(user_id, new_name)
        return {"action": "output", "input": f"会话已重命名为: {new_name}", "error": ""}

    if name == "/history":
        try:
            limit = int(arg) if arg else 5
        except ValueError:
            limit = 5
        limit = max(1, min(limit, 20))
        items = _list_history(limit)
        if not items:
            return {"action": "output", "input": "未找到历史会话", "error": ""}
        lines = []
        for idx, item in enumerate(items, 1):
            lines.append(
                f"{idx}. {item['session_id']}\n   目录: {item['cwd'] or '(未知)'}\n   时间: {item['timestamp'] or '(未知)'}"
            )
        return {"action": "output", "input": "\n\n".join(lines), "error": ""}

    return {"action": "error", "input": "", "error": f"未知会话命令: {command}"}


def process_output(payload: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    user_id = str(context.get("user_id", ""))
    codex_output = payload.get("codex_output", {})
    session_id = codex_output.get("session_id")
    if payload.get("source") == "codex" and session_id:
        set_session(user_id, session_id)

    if payload.get("source") == "codex":
        text = codex_output.get("text", "")
    else:
        text = payload.get("input_result", {}).get("input", "")
    return {"text": text, "attachments": []}
