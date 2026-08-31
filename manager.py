from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
from pathlib import Path

from package_manager.manager import PackageManager
from shared.lock import FileLock
from shared.protocol import PROJECT_ROOT, load_json, save_json

SERVICE_NAME = "wechat-codex-bridge"


def _bridge_pid() -> int | None:
    lock_file = PROJECT_ROOT / "state" / "bridge.lock"
    try:
        return int(lock_file.read_text(encoding="utf-8").strip() or "0")
    except Exception:
        return None


def _is_bridge_process(pid: int) -> bool:
    if pid <= 0:
        return False
    if pid == os.getpid():
        return False
    if os.name == "posix":
        try:
            raw = Path(f"/proc/{pid}/cmdline").read_bytes()
            cmdline = raw.replace(b"\0", b" ").decode("utf-8", errors="ignore")
            return "node" in cmdline and "index.mjs" in cmdline
        except Exception:
            return False
    try:
        os.kill(pid, 0)
        return True
    except OSError as exc:
        return exc.errno == 1  # EPERM


def ensure_service_offline() -> None:
    pid = _bridge_pid()
    if pid and _is_bridge_process(pid):
        raise SystemExit(
            f"后台服务仍在运行，PID={pid}。请先停止服务再运行本地 manager.py。"
        )


def _run_command(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(args, text=True, capture_output=True)


def _service_unit_exists() -> bool:
    return (Path("/etc/systemd/system") / f"{SERVICE_NAME}.service").exists()


def _systemctl(args: list[str], *, sudo: bool = False) -> subprocess.CompletedProcess:
    cmd = ["sudo", "systemctl", *args] if sudo else ["systemctl", *args]
    return _run_command(cmd)


def _service_status() -> None:
    print("后台服务状态：")
    pid = _bridge_pid()
    if pid and _is_bridge_process(pid):
        print(f"  运行中，PID={pid}")
    else:
        print("  未运行")

    if os.name == "posix" and _service_unit_exists():
        result = _systemctl(["is-active", SERVICE_NAME])
        print(f"  systemd: {result.stdout.strip() or result.stderr.strip()}")


def _service_start() -> None:
    pid = _bridge_pid()
    if pid and _is_bridge_process(pid):
        print(f"后台服务已在运行，PID={pid}。")
        return

    if os.name == "posix" and _service_unit_exists():
        result = _systemctl(
            ["start", SERVICE_NAME],
            sudo=os.geteuid() != 0,
        )
        if result.returncode != 0:
            print(f"启动失败：{result.stderr.strip() or result.stdout.strip()}")
            raise SystemExit(result.returncode)
        print("已通过 systemd 启动后台服务。")
        return

    if os.name == "nt":
        result = _run_command(
            ["powershell", "-Command", f"Start-ScheduledTask -TaskName {SERVICE_NAME}"]
        )
        if result.returncode != 0:
            print(f"启动失败：{result.stderr.strip()}")
            raise SystemExit(result.returncode)
        print("已通过 Windows 计划任务启动后台服务。")
        return

    print("未检测到 systemd/计划任务，请手动运行：")
    print(f"  cd {PROJECT_ROOT} && npm start")


def _service_stop() -> None:
    pid = _bridge_pid()
    if pid and _is_bridge_process(pid):
        try:
            os.kill(pid, signal.SIGTERM)
            print(f"已向后台服务 PID={pid} 发送停止信号。")
        except OSError as exc:
            print(f"停止失败：{exc}")
            raise SystemExit(1)

    if os.name == "posix" and _service_unit_exists():
        result = _systemctl(
            ["stop", SERVICE_NAME],
            sudo=os.geteuid() != 0,
        )
        if result.returncode != 0:
            print(f"停止失败：{result.stderr.strip() or result.stdout.strip()}")
            raise SystemExit(result.returncode)
        print("已通过 systemd 停止后台服务。")
        return

    if os.name == "nt":
        result = _run_command(
            ["powershell", "-Command", f"Stop-ScheduledTask -TaskName {SERVICE_NAME}"]
        )
        if result.returncode != 0:
            print(f"停止失败：{result.stderr.strip()}")
            raise SystemExit(result.returncode)
        print("已通过 Windows 计划任务停止后台服务。")
        return

    if not pid:
        print("后台服务未运行。")


def _service_enable() -> None:
    if os.name == "posix" and _service_unit_exists():
        result = _systemctl(
            ["enable", SERVICE_NAME],
            sudo=os.geteuid() != 0,
        )
        if result.returncode != 0:
            print(f"启用失败：{result.stderr.strip()}")
            raise SystemExit(result.returncode)
        print("已设置后台服务开机自启。")
        return
    print("未检测到 systemd 服务文件，无法设置开机自启。")


def _service_disable() -> None:
    if os.name == "posix" and _service_unit_exists():
        result = _systemctl(
            ["disable", SERVICE_NAME],
            sudo=os.geteuid() != 0,
        )
        if result.returncode != 0:
            print(f"禁用失败：{result.stderr.strip()}")
            raise SystemExit(result.returncode)
        print("已取消后台服务开机自启。")
        return
    print("未检测到 systemd 服务文件。")


def _service_restart() -> None:
    _service_stop()
    _service_start()


def _is_service_running() -> bool:
    pid = _bridge_pid()
    if pid and _is_bridge_process(pid):
        return True
    if os.name == "posix" and _service_unit_exists():
        result = _systemctl(["is-active", SERVICE_NAME])
        return result.stdout.strip() == "active"
    return False


def _deploy() -> None:
    ensure_service_offline()
    manager = PackageManager()
    existing = {p.get("path") for p in manager.list_packages()}
    for rel in ["packages/settings", "packages/sessions", "packages/workdir"]:
        if rel not in existing:
            manager.add_package(rel)
            print(f"已注册任务包: {rel}")
    print("部署完成。")


def _run_handler(text: str) -> None:
    ensure_service_offline()
    manager_lock = FileLock(PROJECT_ROOT / "state" / "manager.lock")
    with manager_lock:
        env = os.environ.copy()
        env.update(
            {
                "CODEX_BRIDGE_PROJECT_ROOT": str(PROJECT_ROOT),
                "CODEX_BRIDGE_WORKDIR": str(PROJECT_ROOT),
                "CODEX_BRIDGE_USER_ID": "local",
                "CODEX_BRIDGE_MODE": "local",
            }
        )
        process = subprocess.Popen(
            [sys.executable, str(PROJECT_ROOT / "handler.py")],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=str(PROJECT_ROOT),
            env=env,
            start_new_session=(os.name == "posix"),
        )
        try:
            stdout_text, stderr_text = process.communicate(input=text, timeout=30 * 60)
        except subprocess.TimeoutExpired:
            if os.name == "posix":
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except Exception:
                    process.kill()
            else:
                process.kill()
            stdout_text, stderr_text = process.communicate()
            print("handler 执行超时，已清理相关进程树。")
            raise SystemExit(1)
        try:
            reply = json.loads(stdout_text.strip())
        except Exception:
            print(stdout_text or stderr_text)
            raise SystemExit(process.returncode or 1)
        _print_reply(reply)


def _print_reply(reply: dict) -> None:
    status = reply.get("status", "ok")
    text = reply.get("text", "")
    attachments = reply.get("attachments", [])
    if status == "ok":
        print(f"结果：{text}")
    else:
        print(f"错误：{text}")
    if attachments:
        print(f"附件：{json.dumps(attachments, ensure_ascii=False)}")


def _package_command(args: argparse.Namespace) -> None:
    ensure_service_offline()
    manager = PackageManager()
    if args.package_action == "list":
        for pkg in manager.list_packages():
            print(
                f"{pkg.get('order')}. {pkg.get('name')} id={pkg.get('id')} "
                f"enabled={pkg.get('enabled')} commands={','.join(pkg.get('commands', []))}"
            )
        return
    if args.package_action == "add":
        entry = manager.add_package(args.value)
        print(json.dumps(entry, ensure_ascii=False, indent=2))
        return
    if args.package_action == "remove":
        print("已删除" if manager.remove_package(args.value) else "未找到该包")
        return
    if args.package_action == "enable":
        print("已启用" if manager.set_enabled(args.value, True) else "未找到该包")
        return
    if args.package_action == "disable":
        print("已禁用" if manager.set_enabled(args.value, False) else "未找到该包")
        return
    if args.package_action == "order":
        try:
            order = int(args.order)
        except ValueError:
            raise SystemExit("序号必须是整数")
        print("已调整" if manager.set_order(args.value, order) else "未找到该包")


def _migrate_state() -> None:
    ensure_service_offline()
    old_sessions = load_json(PROJECT_ROOT / "state" / "codex-sessions.json", {})
    sessions_state = load_json(
        PROJECT_ROOT / "packages" / "sessions" / "state.json",
        {"user_sessions": {}},
    )
    sessions_state.setdefault("user_sessions", {}).update(old_sessions)
    save_json(PROJECT_ROOT / "packages" / "sessions" / "state.json", sessions_state)
    print("会话状态已迁移。")


def _run_handler_submenu() -> None:
    manager = PackageManager()
    entries = []
    for pkg in manager.list_packages():
        if not pkg.get("enabled", False):
            continue
        help_map = pkg.get("help", {})
        usage_map = pkg.get("usage", {})
        for command in pkg.get("commands", []):
            description = help_map.get(command) or ""
            if not description:
                for key, value in help_map.items():
                    if key.startswith(command):
                        description = value
                        break
            usage = usage_map.get(command, command)
            entries.append((pkg.get("name", ""), command, usage, description, pkg.get("path", "")))

    while True:
        print("\n运行 handler")
        print("  0. 普通消息（直接发送给 Codex）")
        for idx, (package_name, command, usage, description, _) in enumerate(entries, 1):
            suffix = f" - {description}" if description else ""
            print(f"  {idx}. [{package_name}] {usage}{suffix}")
        print("  q. 返回上级菜单")

        choice = input("请选择命令: ").strip()
        if choice in {"q", "Q", ""}:
            return
        if choice == "0":
            text = input("请输入要发送给 Codex 的消息: ").strip()
            if text:
                _run_handler(text)
            continue

        try:
            idx = int(choice)
            _, command, _, _, package_path = entries[idx - 1]
        except (ValueError, IndexError):
            command = choice if choice.startswith("/") else None
            if command is None:
                print("无效选择")
                continue
            package_path = next(
                (entry[4] for entry in entries if entry[1] == command),
                "",
            )

        usage_text = command
        if package_path:
            try:
                module = manager.load_package_module(package_path)
                help_func = getattr(module, "help", None)
                if help_func:
                    usage_text = help_func(command) or command
            except Exception:
                usage_text = command
        print(f"用法：{usage_text}")

        args = input(f"请输入 {command} 之后的参数（可留空）: ").strip()
        full_command = f"{command} {args}".strip() if args else command
        _run_handler(full_command)
        continue


def _package_submenu() -> None:
    while True:
        options = [
            ("list", "列出任务包"),
            ("add", "添加任务包"),
            ("remove", "删除任务包"),
            ("enable", "启用任务包"),
            ("disable", "禁用任务包"),
            ("order", "调整任务包顺序"),
            ("back", "返回上级菜单"),
        ]
        print("\n任务包管理")
        for idx, (_, desc) in enumerate(options, 1):
            print(f"  {idx}. {desc}")
        choice = input("请选择: ").strip()
        if choice in {"back", "q", "Q", ""}:
            return
        try:
            idx = int(choice)
            action = options[idx - 1][0]
        except (ValueError, IndexError):
            action = choice

        if action == "back":
            return
        if action == "list":
            args = argparse.Namespace(package_action="list", value="", order=None)
            _package_command(args)
            continue

        value = input("请输入任务包 ID 或路径: ").strip()
        if not value:
            print("输入不能为空")
            continue
        if action == "order":
            order = input("请输入新序号: ").strip()
            args = argparse.Namespace(package_action="order", value=value, order=order)
        else:
            args = argparse.Namespace(package_action=action, value=value, order=None)
        try:
            _package_command(args)
        except Exception as exc:
            print(f"执行失败: {exc}")


def _service_submenu() -> None:
    actions = {
        "status": _service_status,
        "start": _service_start,
        "stop": _service_stop,
        "restart": _service_restart,
        "enable": _service_enable,
        "disable": _service_disable,
    }
    labels = [
        ("status", "查看后台服务状态"),
        ("start", "启动后台服务"),
        ("stop", "停止后台服务"),
        ("restart", "重启后台服务"),
        ("enable", "开启后台服务自启"),
        ("disable", "关闭后台服务自启"),
        ("back", "返回上级菜单"),
    ]
    while True:
        print("\n后台服务")
        for idx, (_, desc) in enumerate(labels, 1):
            print(f"  {idx}. {desc}")
        choice = input("请选择: ").strip()
        if choice in {"back", "q", "Q", ""}:
            return
        try:
            idx = int(choice)
            action = labels[idx - 1][0]
        except (ValueError, IndexError):
            action = choice
        if action == "back":
            return
        try:
            actions.get(action, _service_status)()
        except Exception as exc:
            print(f"执行失败: {exc}")


def _install_dependencies() -> None:
    print("安装项目依赖...")
    cmd = ["npm", "ci"] if (PROJECT_ROOT / "package-lock.json").exists() else ["npm", "install"]
    result = _run_command(cmd)
    if result.returncode != 0:
        print(result.stderr.strip())
        raise SystemExit(result.returncode)
    print("依赖安装完成。")


def _login_wechat() -> None:
    ensure_service_offline()
    print("即将启动前台登录，请用手机微信扫描终端二维码。")
    print("登录完成后按 Ctrl-C 退出。")
    try:
        subprocess.run(
            ["node", "index.mjs"],
            cwd=str(PROJECT_ROOT),
        )
    except KeyboardInterrupt:
        print("\n登录流程已退出。")


def _install_service() -> None:
    if os.name == "posix":
        script = PROJECT_ROOT / "deploy" / "install-service.sh"
        if os.geteuid() != 0:
            cmd = ["sudo", "bash", str(script)]
        else:
            cmd = ["bash", str(script)]
        result = _run_command(cmd)
        if result.returncode != 0:
            print(result.stderr.strip() or result.stdout.strip())
            raise SystemExit(result.returncode)
        print("后台服务安装完成。")
        _service_stop()
        print("已自动停止后台服务。")
        return
    if os.name == "nt":
        script = PROJECT_ROOT / "install-windows-service.ps1"
        result = _run_command(
            ["powershell", "-ExecutionPolicy", "Bypass", "-File", str(script)]
        )
        if result.returncode != 0:
            print(result.stderr.strip())
            raise SystemExit(result.returncode)
        print("后台服务安装完成。")
        _service_stop()
        print("已自动停止后台服务。")
        return
    print("当前平台不支持自动安装服务。")


def _uninstall_service() -> None:
    if os.name == "posix":
        _service_stop()
        _service_disable()
        unit = Path("/etc/systemd/system") / f"{SERVICE_NAME}.service"
        if unit.exists():
            sudo = os.geteuid() != 0
            rm_cmd = ["sudo", "rm", "-f", str(unit)] if sudo else ["rm", "-f", str(unit)]
            result = _run_command(rm_cmd)
            if result.returncode != 0:
                print(result.stderr.strip())
                raise SystemExit(result.returncode)
            reload_cmd = ["sudo", "systemctl", "daemon-reload"] if sudo else ["systemctl", "daemon-reload"]
            result = _run_command(reload_cmd)
            if result.returncode != 0:
                print(result.stderr.strip())
                raise SystemExit(result.returncode)
        print("后台服务已卸载。")
        return
    if os.name == "nt":
        script = PROJECT_ROOT / "uninstall-windows-service.ps1"
        result = _run_command(
            ["powershell", "-ExecutionPolicy", "Bypass", "-File", str(script)]
        )
        if result.returncode != 0:
            print(result.stderr.strip())
            raise SystemExit(result.returncode)
        print("后台服务已卸载。")
        return
    print("当前平台不支持自动卸载服务。")


def _clean_project_state() -> None:
    print("此操作会删除 state/ 和 runtime/ 目录。")
    answer = input("确认删除？[y/N]: ").strip().lower()
    if answer not in {"y", "yes"}:
        return
    import shutil as _shutil

    for rel in ["state", "runtime"]:
        _shutil.rmtree(PROJECT_ROOT / rel, ignore_errors=True)
    print("项目运行状态已清理。")


def _project_submenu() -> None:
    options = [
        ("deps", "安装项目依赖"),
        ("login", "首次扫码登录微信"),
        ("deploy", "部署并注册内置任务包"),
        ("migrate-state", "迁移 Node 状态"),
        ("install-service", "安装后台服务"),
        ("uninstall-service", "卸载后台服务"),
        ("clean-state", "清理运行状态"),
        ("back", "返回上级菜单"),
    ]
    while True:
        print("\n项目安装/卸载")
        for idx, (_, desc) in enumerate(options, 1):
            print(f"  {idx}. {desc}")
        choice = input("请选择: ").strip()
        if choice in {"back", "q", "Q", ""}:
            return
        try:
            idx = int(choice)
            action = options[idx - 1][0]
        except (ValueError, IndexError):
            action = choice

        try:
            if action == "deps":
                _install_dependencies()
            elif action == "login":
                _login_wechat()
            elif action == "deploy":
                _deploy()
            elif action == "install-service":
                _install_service()
            elif action == "migrate-state":
                _migrate_state()
            elif action == "uninstall-service":
                _uninstall_service()
            elif action == "clean-state":
                _clean_project_state()
            elif action == "back":
                return
            else:
                print("未知选项")
        except SystemExit:
            pass
        except Exception as exc:
            print(f"执行失败: {exc}")


def _interactive_menu() -> None:
    if _is_service_running():
        print("检测到后台服务正在运行。")
        answer = input("是否先关闭服务再继续进入菜单？[y/N]: ").strip().lower()
        if answer in {"y", "yes"}:
            _service_stop()

    options = [
        ("handler", "运行一次 handler"),
        ("packages", "任务包管理"),
        ("service", "后台服务管理"),
        ("project", "项目安装/卸载"),
        ("exit", "退出"),
    ]

    while True:
        print("\nwechat-codex-bridge 本地管理器")
        for idx, (_, desc) in enumerate(options, 1):
            print(f"  {idx}. {desc}")
        try:
            choice = input("请选择: ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if not choice:
            continue
        if choice in {"0", "exit", "q"}:
            break
        try:
            idx = int(choice)
            action = options[idx - 1][0]
        except (ValueError, IndexError):
            action = choice

        try:
            if action == "handler":
                _run_handler_submenu()
            elif action == "packages":
                _package_submenu()
            elif action == "service":
                _service_submenu()
            elif action == "project":
                _project_submenu()
            elif action in {"exit", "q"}:
                break
            else:
                print("未知选项")
        except SystemExit:
            pass
        except Exception as exc:
            print(f"执行失败: {exc}")

    if not _is_service_running():
        answer = input("退出前是否开启后台服务？[y/N]: ").strip().lower()
        if answer in {"y", "yes"}:
            _service_start()


def main() -> None:
    parser = argparse.ArgumentParser(description="wechat-codex-bridge 本地管理器")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("deploy", help="部署并注册内置任务包")
    sub.add_parser("migrate-state", help="迁移 Node 状态到任务包目录")
    sub.add_parser("login", help="前台扫码登录个人微信")
    sub.add_parser("menu", help="进入交互式菜单")
    run = sub.add_parser("run", help="进入交互式输入")
    run.add_argument("text", nargs="?", help="要发送给 handler 的文本")
    once = sub.add_parser("run-once", help="运行一次")
    once.add_argument("text")

    service = sub.add_parser("service", help="后台服务管理")
    service.add_argument(
        "service_action",
        choices=["status", "start", "stop", "restart", "enable", "disable"],
        default="status",
    )

    pkg = sub.add_parser("package", help="任务包管理")
    pkg.add_argument("package_action", choices=["list", "add", "remove", "enable", "disable", "order"])
    pkg.add_argument("value")
    pkg.add_argument("order", nargs="?")

    args = parser.parse_args()
    if not args.command:
        _interactive_menu()
    elif args.command == "menu":
        _interactive_menu()
    elif args.command == "deploy":
        _deploy()
    elif args.command == "migrate-state":
        _migrate_state()
    elif args.command == "login":
        _login_wechat()
    elif args.command == "run-once":
        _run_handler(args.text)
    elif args.command == "run":
        if args.text:
            _run_handler(args.text)
        else:
            text = sys.stdin.read()
            _run_handler(text)
    elif args.command == "package":
        _package_command(args)
    elif args.command == "service":
        {
            "status": _service_status,
            "start": _service_start,
            "stop": _service_stop,
            "restart": _service_restart,
            "enable": _service_enable,
            "disable": _service_disable,
        }[args.service_action]()
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
