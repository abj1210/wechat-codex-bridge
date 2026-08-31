from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from shared.protocol import PROJECT_ROOT, load_json, save_json

PACKAGE_INFO = {
    "name": "workdir",
    "commands": ["/cd", "/workdir"],
    "help": {
        "/cd <dir>": "设置当前用户的工作目录",
        "/workdir": "查看当前用户的工作目录",
    },
    "usage": {
        "/cd": "/cd <目录>",
        "/workdir": "/workdir",
    },
}

STATE_PATH = PROJECT_ROOT / "packages" / "workdir" / "state.json"


def help(command: str) -> str:
    return PACKAGE_INFO.get("usage", {}).get(command, command)


def _resolve_workdir(path: str) -> str:
    p = Path(path)
    if not p.is_absolute():
        p = PROJECT_ROOT / p
    return str(p.resolve())


def _state() -> dict[str, Any]:
    return load_json(STATE_PATH, {"user_workdirs": {}})


def get_workdir(user_id: str) -> str:
    state = _state()
    configured = state.get("user_workdirs", {}).get(user_id)
    if configured:
        return _resolve_workdir(configured)
    cfg = load_json(PROJECT_ROOT / "config.json", {})
    return _resolve_workdir(str(cfg.get("workdir", PROJECT_ROOT)))


def _allowed(target: str) -> bool:
    cfg = load_json(PROJECT_ROOT / "config.json", {})
    allowed = cfg.get("allowedWorkdirs") or []
    if not allowed:
        return True
    target_path = Path(target).resolve()
    for item in allowed:
        root = Path(item).resolve()
        if target_path == root or root in target_path.parents:
            return True
    return False


def process_input(command: str, context: dict[str, Any]) -> dict[str, Any]:
    user_id = str(context.get("user_id", ""))
    parts = command.split(maxsplit=1)
    name = parts[0]
    arg = parts[1].strip() if len(parts) > 1 else ""

    if name == "/workdir":
        return {"action": "output", "input": get_workdir(user_id), "error": ""}

    if name == "/cd":
        if not arg:
            return {"action": "error", "input": "", "error": "用法: /cd <目录>"}
        cfg = load_json(PROJECT_ROOT / "config.json", {})
        base = Path(_resolve_workdir(str(cfg.get("workdir", PROJECT_ROOT))))
        candidate = Path(arg)
        if not candidate.is_absolute():
            candidate = base / candidate
        candidate = candidate.resolve()
        if not candidate.is_dir():
            return {"action": "error", "input": "", "error": f"目录不存在: {candidate}"}
        if not _allowed(str(candidate)):
            return {"action": "error", "input": "", "error": f"目录不在白名单内: {candidate}"}
        state = _state()
        state.setdefault("user_workdirs", {})[user_id] = str(candidate)
        save_json(STATE_PATH, state)
        return {"action": "output", "input": f"工作目录已设置为: {candidate}", "error": ""}

    return {"action": "error", "input": "", "error": f"未知目录命令: {command}"}


def process_output(payload: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    return {
        "text": payload.get("input_result", {}).get("input", ""),
        "attachments": [],
    }
