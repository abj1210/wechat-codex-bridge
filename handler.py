from __future__ import annotations

import json
import os
import sys
import uuid
from pathlib import Path
from typing import Any

from package_manager.manager import PackageManager
from shared.codex_client import run_codex
from shared.protocol import PROJECT_ROOT, RUNTIME_ROOT, final_result, load_json, save_json
from packages.sessions import package as sessions_package
from packages.workdir import package as workdir_package


def _context() -> dict[str, Any]:
    return {
        "project_root": str(PROJECT_ROOT),
        "workdir": os.environ.get("CODEX_BRIDGE_WORKDIR", str(PROJECT_ROOT)),
        "user_id": os.environ.get("CODEX_BRIDGE_USER_ID", ""),
        "mode": os.environ.get("CODEX_BRIDGE_MODE", "local"),
    }


def _help_text() -> str:
    return (
        "可用命令：\n"
        "/config\n/model\n/sandbox [mode]\n/network [on|off]\n"
        "/cd <目录>\n/workdir\n/session\n/resume <id|last>\n/new\n/history [n]\n/help"
    )


def _run_package_command(command: str, context: dict[str, Any]) -> dict[str, Any]:
    manager = PackageManager()
    found = manager.find_package(command)
    if not found:
        return final_result("error", f"未知命令: {command}")

    package_path, _ = found
    module = manager.load_package_module(package_path)
    input_result = module.process_input(command, context)
    action = input_result.get("action", "error")

    if action == "error":
        return final_result("error", input_result.get("error", "任务包处理失败"))

    if action == "output":
        payload = {
            "source": "package",
            "input_result": input_result,
            "codex_output": {},
            "package_output": {},
        }
        output = module.process_output(payload, context)
        return final_result("ok", output.get("text", ""), output.get("attachments", []))

    if action == "codex":
        prompt = input_result.get("input", "")
        session_id = sessions_package.get_session(context["user_id"])
        resume_last = session_id == "last"
        resume_session_id = None if resume_last else session_id
        codex_output = run_codex(
            prompt,
            workdir_package.get_workdir(context["user_id"]),
            session_id=resume_session_id,
            resume_last=resume_last,
        )
        payload = {
            "source": "codex",
            "input_result": input_result,
            "codex_output": codex_output,
            "package_output": {},
        }
        output = module.process_output(payload, context)
        return final_result("ok", output.get("text", ""), output.get("attachments", []))

    return final_result("error", f"不支持的任务包动作: {action}")


def _run_normal_message(text: str, context: dict[str, Any]) -> dict[str, Any]:
    session_id = sessions_package.get_session(context["user_id"])
    resume_last = session_id == "last"
    resume_session_id = None if resume_last else session_id
    codex_output = run_codex(
        text,
        workdir_package.get_workdir(context["user_id"]),
        session_id=resume_session_id,
        resume_last=resume_last,
    )
    if codex_output.get("session_id"):
        sessions_package.set_session(context["user_id"], codex_output["session_id"])
    return final_result("ok", codex_output.get("text", ""))


def main() -> int:
    text = sys.stdin.read()
    context = _context()
    run_id = uuid.uuid4().hex
    run_dir = RUNTIME_ROOT / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    input_data = {
        "run_id": run_id,
        "user_id": context["user_id"],
        "workdir": workdir_package.get_workdir(context["user_id"]),
        "text": text,
        "kind": "command" if text.lstrip().startswith("/") else "message",
        "mode": context["mode"],
    }
    save_json(run_dir / "input.json", input_data)

    try:
        trimmed = text.strip()
        if not trimmed:
            result = final_result("error", "输入为空")
        elif trimmed.startswith("/help"):
            result = final_result("ok", _help_text())
        elif trimmed.startswith("/"):
            result = _run_package_command(trimmed, context)
        else:
            result = _run_normal_message(trimmed, context)
    except Exception as exc:
        result = final_result("error", str(exc))

    save_json(run_dir / "final_reply.json", result)
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("status") == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())
