from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Any

from .protocol import PROJECT_ROOT, load_json


def _load_config() -> dict[str, Any]:
    return load_json(PROJECT_ROOT / "config.json", {})


def _read_last_message(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        return ""


def run_codex(
    prompt: str,
    workdir: str | Path,
    *,
    session_id: str | None = None,
    resume_last: bool = False,
    timeout_seconds: int = 30 * 60,
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
    result = subprocess.run(
        args,
        cwd=workdir,
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
    )

    text = ""
    thread_id = ""
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except Exception:
            continue
        if ev.get("type") == "thread.started" and ev.get("thread_id"):
            thread_id = ev["thread_id"]
        if ev.get("type") == "item.completed" and isinstance(ev.get("item"), dict):
            item_text = ev["item"].get("text")
            if isinstance(item_text, str):
                text = item_text

    last_text = _read_last_message(last_msg)
    if last_text.strip():
        text = last_text

    shutil.rmtree(tmp_dir, ignore_errors=True)

    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"codex exit {result.returncode}")

    return {
        "status": "ok",
        "text": text.strip(),
        "session_id": thread_id,
        "exit_code": 0,
    }
