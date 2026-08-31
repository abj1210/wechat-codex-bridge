from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from .protocol import PROJECT_ROOT, load_json, save_json


class CodexWatchdogTimeout(Exception):
    pass


class CodexStopped(Exception):
    pass


def _load_config() -> dict[str, Any]:
    return load_json(PROJECT_ROOT / "config.json", {})


def _read_last_message(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        return ""


def _write_progress(progress_file: str | Path | None, stage: str, detail: str) -> None:
    if not progress_file:
        return
    try:
        save_json(
            progress_file,
            {
                "stage": stage,
                "detail": detail,
                "updated_at": datetime.now().isoformat(),
            },
        )
    except Exception:
        pass


def run_codex(
    prompt: str,
    workdir: str | Path,
    *,
    session_id: str | None = None,
    resume_last: bool = False,
    timeout_seconds: int = 30 * 60,
    progress_file: str | Path | None = None,
    heartbeat_file: str | Path | None = None,
    stop_file: str | Path | None = None,
) -> dict[str, Any]:
    config = _load_config()
    workdir = str(workdir)
    sandbox_mode = config.get("sandboxMode") or ""
    network_access = config.get("networkAccess", False)
    auto_approve = bool(config.get("autoApprove", False))
    skip_git = config.get("skipGitRepoCheck", True)

    tmp_dir = Path(tempfile.mkdtemp(prefix="codex-python-"))
    last_msg = tmp_dir / f"last-{uuid.uuid4().hex}.txt"
    is_resume = bool(session_id or resume_last)

    args = ["codex"]
    if is_resume:
        args += ["exec", "resume"]
        if resume_last:
            args.append("--last")
        elif session_id:
            args.append(session_id)
        args += ["--json"]
    else:
        args += ["exec", "--json", "--color", "never", "-C", workdir]

    args += ["-o", str(last_msg)]

    if sandbox_mode:
        if is_resume:
            args += ["-c", f"sandbox_mode={sandbox_mode}"]
        else:
            args += ["-s", sandbox_mode]
    if network_access and sandbox_mode == "workspace-write":
        args += ["-c", "sandbox_workspace_write.network_access=true"]
    if skip_git:
        args.append("--skip-git-repo-check")
    if auto_approve and not is_resume:
        args.append("--approve-for-me")

    if not is_resume:
        args.append("--")
    args.append(prompt)

    env = os.environ.copy()
    stderr_path = tmp_dir / "stderr.log"
    with open(stderr_path, "w", encoding="utf-8") as stderr_file:
        process = subprocess.Popen(
            args,
            cwd=workdir,
            env=env,
            stdout=subprocess.PIPE,
            stderr=stderr_file,
            text=True,
            start_new_session=(os.name == "posix"),
        )
        state = {"text": "", "thread_id": "", "partial": ""}

        def read_stdout() -> None:
            assert process.stdout is not None
            for line in process.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except Exception:
                    continue
                if ev.get("type") == "thread.started" and ev.get("thread_id"):
                    state["thread_id"] = ev["thread_id"]
                if ev.get("type") == "item.completed" and isinstance(ev.get("item"), dict):
                    item_text = ev["item"].get("text")
                    if isinstance(item_text, str):
                        state["text"] = item_text
                        _write_progress(
                            progress_file,
                            "codex",
                            f"已生成回答：{item_text[-120:]}",
                        )
                delta = ev.get("delta")
                if isinstance(delta, str):
                    state["partial"] += delta
                    _write_progress(
                        progress_file,
                        "codex",
                        f"正在生成回答：{state['partial'][-120:]}",
                    )
                elif ev.get("type") == "tool_call" and isinstance(ev.get("tool_name"), str):
                    _write_progress(progress_file, "tool", f"正在调用工具：{ev['tool_name']}")

        reader = threading.Thread(target=read_stdout, daemon=True)
        reader.start()
        started = time.time()
        last_seen = started
        while process.poll() is None:
            if stop_file and Path(stop_file).exists():
                if os.name == "posix":
                    try:
                        os.killpg(process.pid, signal.SIGTERM)
                    except Exception:
                        process.kill()
                else:
                    process.kill()
                process.wait()
                reader.join(timeout=2)
                raise CodexStopped("codex stopped")
            if heartbeat_file:
                try:
                    last_seen = max(last_seen, Path(heartbeat_file).stat().st_mtime)
                except Exception:
                    pass
            if time.time() - last_seen > timeout_seconds:
                if os.name == "posix":
                    try:
                        os.killpg(process.pid, signal.SIGTERM)
                    except Exception:
                        process.kill()
                else:
                    process.kill()
                process.wait()
                reader.join(timeout=2)
                raise CodexWatchdogTimeout("codex watchdog timeout")
            time.sleep(1)
        reader.join(timeout=2)

    stderr_text = stderr_path.read_text(encoding="utf-8", errors="ignore")
    text = state["text"]
    thread_id = state["thread_id"]

    last_text = _read_last_message(last_msg)
    if last_text.strip():
        text = last_text

    shutil.rmtree(tmp_dir, ignore_errors=True)

    if process.returncode != 0:
        raise RuntimeError(stderr_text.strip() or f"codex exit {process.returncode}")

    return {
        "status": "ok",
        "text": text.strip(),
        "session_id": thread_id,
        "exit_code": 0,
    }
