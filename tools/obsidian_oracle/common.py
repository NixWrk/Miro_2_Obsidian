from __future__ import annotations

import json
import os
import stat
from pathlib import Path
from typing import Any


TOOL_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOL_DIR.parents[1]
CONFIG_PATH = TOOL_DIR / "oracle_config.json"


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8-sig") as f:
        return json.load(f)


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def load_config() -> dict[str, Any]:
    return load_json(CONFIG_PATH)


def resolve_path(raw_path: str) -> Path:
    expanded = (
        raw_path
        .replace("${repo_root}", str(REPO_ROOT))
        .replace("${tool_dir}", str(TOOL_DIR))
    )
    expanded = os.path.expandvars(expanded)
    path = Path(expanded).expanduser()
    if not path.is_absolute():
        path = REPO_ROOT / path
    return path


def vault_path(config: dict[str, Any] | None = None) -> Path:
    cfg = config or load_config()
    return resolve_path(str(cfg["vault_path"]))


def work_dir(config: dict[str, Any] | None = None) -> Path:
    cfg = config or load_config()
    return vault_path(cfg) / str(cfg["work_folder"])


def obsidian_dir(config: dict[str, Any] | None = None) -> Path:
    return vault_path(config) / ".obsidian"


def _is_link_or_reparse(path: Path) -> bool:
    """Return whether *path* is a link/reparse point without following it."""

    if path.is_symlink():
        return True
    try:
        attributes = path.stat(follow_symlinks=False).st_file_attributes
    except (AttributeError, FileNotFoundError, OSError):
        return False
    return bool(attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def _first_link_or_reparse(path: Path) -> Path | None:
    """Find a link/reparse point in an existing path's ancestor chain."""

    current = Path(path).absolute()
    while True:
        if _is_link_or_reparse(current):
            return current
        if current.parent == current:
            return None
        current = current.parent


def require_oracle_vault(
    candidate: Path | str | None = None,
    config: dict[str, Any] | None = None,
) -> Path:
    """Resolve and guard the project-local oracle vault.

    The oracle is deliberately not a generic-vault installer.  A caller may
    omit ``candidate`` or pass the exact configured path, but any other path
    is rejected before filesystem mutation.  Existing ancestors are checked
    without following links/reparse points so a path that merely resolves
    inside the repository cannot redirect writes to a user vault.
    """

    configured = vault_path(config).absolute().resolve(strict=False)
    requested = configured if candidate is None else Path(candidate).expanduser().absolute()
    requested_resolved = requested.resolve(strict=False)
    if requested_resolved != configured:
        raise ValueError(
            "Oracle vault target must be exactly the configured project-local vault: "
            f"{configured}"
        )

    link_path = _first_link_or_reparse(requested)
    if link_path is not None:
        raise ValueError(f"Oracle vault path contains a link or reparse point: {link_path}")
    return configured

