#!/usr/bin/env python3
"""Ticiou SessionStart hook.

Emits a small, structured summary of the active Ticiou profile. The shape
matches Claude Code and Copilot hook JSON conventions used by Trellis:
`hookSpecificOutput.additionalContext` carries the injected context.
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


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def main() -> int:
    if os.environ.get("TICIOU_HOOKS") == "0" or os.environ.get("TICIOU_DISABLE_HOOKS") == "1":
        return 0

    _configure_utf8()
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        payload = {}

    cwd = Path(payload.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd())
    root = _find_ticiou_root(cwd)
    if root is None:
        return 0

    profile = _read_text(root / ".ticiou" / ".runtime" / "current-profile") or "(none)"
    manifest_path = root / ".ticiou" / ".runtime" / "manifest.json"
    generated_count = 0
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        files = manifest.get("files", [])
        if isinstance(files, list):
            generated_count = len(files)
    except (OSError, json.JSONDecodeError):
        pass

    context = (
        "<ticiou-context>\n"
        f"Target: {root}\n"
        f"Active profile: {profile}\n"
        f"Generated files: {generated_count}\n"
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
