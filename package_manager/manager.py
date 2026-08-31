from __future__ import annotations

import importlib.util
import shlex
import sys
import uuid
from pathlib import Path
from typing import Any

from shared.protocol import PROJECT_ROOT, load_json, save_json

REGISTRY_PATH = PROJECT_ROOT / "package_manager" / "registry.json"


class PackageManager:
    def __init__(self, registry_path: Path = REGISTRY_PATH):
        self.registry_path = registry_path

    def load(self) -> dict[str, Any]:
        return load_json(self.registry_path, {"version": 1, "packages": []})

    def save(self, data: dict[str, Any]) -> None:
        save_json(self.registry_path, data)

    def list_packages(self) -> list[dict[str, Any]]:
        data = self.load()
        return sorted(data.get("packages", []), key=lambda p: p.get("order", 0))

    def get_package(self, package_id: str) -> dict[str, Any] | None:
        for item in self.list_packages():
            if item.get("id") == package_id:
                return item
        return None

    def add_package(self, package_dir: str | Path) -> dict[str, Any]:
        package_dir = (PROJECT_ROOT / package_dir).resolve()
        package_file = package_dir / "package.py"
        if not package_file.exists():
            raise FileNotFoundError(f"未找到任务包文件: {package_file}")

        info = self._load_package_info(package_file)
        data = self.load()
        packages = data.setdefault("packages", [])
        next_order = max([p.get("order", 0) for p in packages], default=0) + 1
        entry = {
            "id": uuid.uuid4().hex,
            "name": info.get("name", package_dir.name),
            "module_name": package_dir.name,
            "path": str(package_dir.relative_to(PROJECT_ROOT)),
            "enabled": True,
            "commands": info.get("commands", []),
            "order": next_order,
            "help": info.get("help", {}),
            "usage": info.get("usage", {}),
        }
        packages.append(entry)
        self.save(data)
        return entry

    def remove_package(self, package_id: str) -> bool:
        data = self.load()
        packages = data.get("packages", [])
        filtered = [p for p in packages if p.get("id") != package_id]
        changed = len(filtered) != len(packages)
        if changed:
            data["packages"] = filtered
            self._renumber(data["packages"])
            self.save(data)
        return changed

    def set_enabled(self, package_id: str, enabled: bool) -> bool:
        data = self.load()
        for pkg in data.get("packages", []):
            if pkg.get("id") == package_id:
                pkg["enabled"] = enabled
                self.save(data)
                return True
        return False

    def set_order(self, package_id: str, target_order: int) -> bool:
        data = self.load()
        packages = data.get("packages", [])
        target = next((p for p in packages if p.get("id") == package_id), None)
        if target is None:
            return False
        packages = [p for p in packages if p.get("id") != package_id]
        insert_at = max(0, min(target_order - 1, len(packages)))
        packages.insert(insert_at, target)
        data["packages"] = packages
        self._renumber(packages)
        self.save(data)
        return True

    def find_package(self, command: str) -> tuple[str, dict[str, Any]] | None:
        command_name = shlex.split(command)[0] if command.strip() else ""
        if not command_name:
            return None
        for pkg in self.list_packages():
            if not pkg.get("enabled", False):
                continue
            commands = pkg.get("commands", [])
            if any(self._command_matches(command_name, item) for item in commands):
                return pkg["path"], pkg
        return None

    def load_package_module(self, package_path: str):
        package_dir = PROJECT_ROOT / package_path
        package_file = package_dir / "package.py"
        if not package_file.exists():
            raise FileNotFoundError(f"任务包不存在: {package_file}")
        spec = importlib.util.spec_from_file_location(
            f"wechat_package_{package_dir.name}_{uuid.uuid4().hex}",
            package_file,
        )
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        return module

    def _command_matches(self, actual: str, expected: str) -> bool:
        return actual == expected or actual == expected.lstrip("/")

    def _renumber(self, packages: list[dict[str, Any]]) -> None:
        for idx, pkg in enumerate(packages, start=1):
            pkg["order"] = idx

    def _load_package_info(self, package_file: Path) -> dict[str, Any]:
        spec = importlib.util.spec_from_file_location(
            f"wechat_package_info_{uuid.uuid4().hex}", package_file
        )
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        return getattr(module, "PACKAGE_INFO", {})
