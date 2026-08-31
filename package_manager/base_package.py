from __future__ import annotations

from typing import Any


class BasePackage:
    PACKAGE_INFO: dict[str, Any] = {
        "name": "",
        "commands": [],
        "help": {},
    }

    def process_input(self, command: str, context: dict[str, Any]) -> dict[str, Any]:
        return {"action": "error", "input": "", "error": "not implemented"}

    def process_output(self, payload: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
        return {"text": "", "attachments": []}
