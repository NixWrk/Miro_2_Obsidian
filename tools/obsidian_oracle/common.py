from __future__ import annotations

import json
import os
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

