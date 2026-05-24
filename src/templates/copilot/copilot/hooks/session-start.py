#!/usr/bin/env python3
"""Ticiou SessionStart hook for Copilot.

Copilot uses the same JSON `additionalContext` shape as other hook-capable
hosts, but keeps hook files under `.github/copilot/hooks`.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def _configure_utf8() -> None:
    if not sys.platform.startswith("win"):
        return
    for stream_name in ("stdin", "stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        if stream is not None and hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


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

    _configure_utf8()
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        payload = {}

    root = _find_ticiou_root(Path(payload.get("cwd") or os.environ.get("COPILOT_PROJECT_DIR") or os.getcwd()))
    if root is None:
        return 0

    context = (
        "<ticiou-context>\n"
        f"Target: {root}\n"
        f"Active profile: {_read_profile(root)}\n"
        "Shared and active-user resources have been rendered by Ticiou.\n"
        "</ticiou-context>"
    )
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "SessionStart",
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
