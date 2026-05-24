#!/usr/bin/env python3
"""Ticiou per-turn context hook for Copilot."""
from __future__ import annotations

import json
import os
from pathlib import Path


def _find_ticiou_root(start: Path) -> Path | None:
    current = start.resolve()
    while True:
        if (current / ".ticiou" / "config.yaml").is_file():
            return current
        if current.parent == current:
            return None
        current = current.parent


def _read_profile(root: Path) -> str:
    try:
        value = (root / ".ticiou" / ".runtime" / "current-profile").read_text(encoding="utf-8").strip()
    except OSError:
        return "(none)"
    return value or "(none)"


def main() -> int:
    if os.environ.get("TICIOU_HOOKS") == "0" or os.environ.get("TICIOU_DISABLE_HOOKS") == "1":
        return 0

    try:
        payload = json.load(open(0, encoding="utf-8"))
    except (json.JSONDecodeError, ValueError, OSError):
        payload = {}

    root = _find_ticiou_root(Path(payload.get("cwd") or os.getcwd()))
    if root is None:
        return 0

    context = (
        "<ticiou-state>\n"
        f"Active profile: {_read_profile(root)}\n"
        "Use the rendered shared and active-user resources for this project.\n"
        "</ticiou-state>"
    )
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "UserPromptSubmit",
                    "additionalContext": context,
                }
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
