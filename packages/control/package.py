from __future__ import annotations

from typing import Any

from shared.protocol import PROJECT_ROOT, load_json, save_json

PACKAGE_INFO = {
    "name": "control",
    "commands": ["/pause", "/continue", "/stop"],
    "help": {
        "/pause": "暂停接收新任务并静默当前任务进度",
        "/continue": "恢复接收新任务和进度消息",
        "/stop": "打断当前正在运行的 Codex 任务",
    },
    "usage": {
        "/pause": "/pause",
        "/continue": "/continue",
        "/stop": "/stop",
    },
}

STATE_PATH = PROJECT_ROOT / "packages" / "control" / "state.json"


def help(command: str) -> str:
    return PACKAGE_INFO.get("usage", {}).get(command, command)


def is_paused() -> bool:
    return bool(load_json(STATE_PATH, {"paused": False}).get("paused", False))


def _set_paused(value: bool) -> None:
    save_json(STATE_PATH, {"paused": value})


def process_input(command: str, context: dict[str, Any]) -> dict[str, Any]:
    name = command.split(maxsplit=1)[0]
    if name == "/pause":
        _set_paused(True)
        return {"action": "output", "input": "当前工作已暂停。", "error": ""}
    if name == "/continue":
        _set_paused(False)
        return {"action": "output", "input": "当前工作已恢复。", "error": ""}
    if name == "/stop":
        return {"action": "output", "input": "已请求打断当前任务。", "error": ""}
    return {"action": "error", "input": "", "error": f"未知控制命令: {command}"}


def process_output(payload: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    return {
        "text": payload.get("input_result", {}).get("input", ""),
        "attachments": [],
    }
