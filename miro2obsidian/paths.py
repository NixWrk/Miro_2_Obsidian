"""Per-user data locations shared by the browser bridge and the Web SDK handoff."""

from __future__ import annotations

import os
import sys
from pathlib import Path

CAPTURE_DIR_ENV = "MIRO2OBSIDIAN_CAPTURE_DIR"


def app_data_dir() -> Path:
    """Return the per-user ``miro2obsidian`` application data directory.

    The directory is not created. It lives under ``%LOCALAPPDATA%`` on Windows,
    ``~/Library/Application Support`` on macOS and ``$XDG_DATA_HOME`` (default
    ``~/.local/share``) elsewhere.
    """
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    return (base / "miro2obsidian").resolve()


def default_capture_dir() -> Path:
    """Directory that receives Web SDK captures (``MIRO2OBSIDIAN_CAPTURE_DIR`` overrides)."""
    override = os.environ.get(CAPTURE_DIR_ENV)
    if override:
        return Path(override).expanduser().resolve()
    return app_data_dir() / "websdk-captures"
