from __future__ import annotations

import tomllib
from pathlib import Path
from typing import Any

from shared.protocol import PROJECT_ROOT, load_json, save_json

PACKAGE_INFO = {
    "name": "settings",
    "commands": ["/config", "/model", "/sandbox", "/network", "/heartbeat"],
    "help": {
        "/config": "查看当前桥接配置",
        "/model": "查看 Codex 当前模型",
        "/sandbox [mode]": "查看或设置沙盒模式",
        "/network [on|off]": "查看或设置网络访问",
        "/heartbeat <分钟>": "设置心跳时间，0-30 分钟；0 为静默",
    },
    "usage": {
        "/config": "/config",
        "/model": "/model",
        "/sandbox": "/sandbox <read-only|workspace-write|danger-full-access>",
        "/network": "/network <on|off>",
        "/heartbeat": "/heartbeat <0-30>",
    },
}


def help(command: str) -> str:
    return PACKAGE_INFO.get("usage", {}).get(command, command)


def _config() -> dict[str, Any]:
    return load_json(PROJECT_ROOT / "config.json", {})


def _save_config(cfg: dict[str, Any]) -> None:
    save_json(PROJECT_ROOT / "config.json", cfg)


def _codex_config() -> dict[str, Any]:
    path = Path.home() / ".codex" / "config.toml"
    try:
        with open(path, "rb") as f:
            return tomllib.load(f)
    except Exception:
        return {}


def process_input(command: str, context: dict[str, Any]) -> dict[str, Any]:
    parts = command.split(maxsplit=1)
    name = parts[0]
    arg = parts[1].strip() if len(parts) > 1 else ""
    cfg = _config()

    if name == "/config":
        text = "\n".join(f"{k}: {v}" for k, v in cfg.items())
        return {"action": "output", "input": text, "error": ""}

    if name == "/model":
        codex_cfg = _codex_config()
        model = codex_cfg.get("model", "未在 ~/.codex/config.toml 中配置")
        provider = codex_cfg.get("model_provider", "")
        text = model if not provider else f"{model} ({provider})"
        return {"action": "output", "input": text, "error": ""}

    if name == "/sandbox":
        allowed = {"read-only", "workspace-write", "danger-full-access"}
        if not arg:
            return {"action": "output", "input": cfg.get("sandboxMode", ""), "error": ""}
        if arg not in allowed:
            return {"action": "error", "input": "", "error": f"无效沙盒模式: {arg}"}
        cfg["sandboxMode"] = arg
        _save_config(cfg)
        return {"action": "output", "input": f"沙盒模式已设置为: {arg}", "error": ""}

    if name == "/network":
        if not arg:
            return {
                "action": "output",
                "input": "on" if cfg.get("networkAccess", False) else "off",
                "error": "",
            }
        value = arg.lower() in {"on", "true", "1", "yes"}
        cfg["networkAccess"] = value
        _save_config(cfg)
        return {"action": "output", "input": f"网络访问已{'开启' if value else '关闭'}", "error": ""}

    if name == "/heartbeat":
        if not arg:
            return {"action": "output", "input": f"{cfg.get('heartbeatMinutes', 10)}", "error": ""}
        try:
            minutes = int(arg)
        except ValueError:
            return {"action": "error", "input": "", "error": "心跳分钟数必须是 0-30 的整数"}
        if minutes < 0 or minutes > 30:
            return {"action": "error", "input": "", "error": "心跳分钟数必须在 0-30 之间"}
        cfg["heartbeatMinutes"] = minutes
        _save_config(cfg)
        if minutes == 0:
            return {"action": "output", "input": "心跳已设为静默，但仍会内部刷新超时计时器", "error": ""}
        return {"action": "output", "input": f"心跳时间已设置为 {minutes} 分钟", "error": ""}

    return {"action": "error", "input": "", "error": f"未知设置命令: {command}"}


def process_output(payload: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    text = payload.get("input_result", {}).get("input", "")
    if payload.get("source") == "codex":
        text = payload.get("codex_output", {}).get("text", "")
    return {"text": text, "attachments": []}
