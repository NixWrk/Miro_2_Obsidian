from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class VaultPaths:
    vault_root: Path
    canvas_folder: Path
    attachment_dir: Path | None


def find_vault_root(start: Path) -> Path | None:
    current = Path(start).resolve()
    if current.is_file():
        current = current.parent
    while True:
        if (current / ".obsidian").is_dir():
            return current
        if current.parent == current:
            return None
        current = current.parent


def load_obsidian_app_settings(vault_root: Path) -> dict[str, Any]:
    path = Path(vault_root) / ".obsidian" / "app.json"
    if not path.is_file():
        return {}
    text = path.read_text(encoding="utf-8-sig").strip()
    if not text:
        return {}
    payload = json.loads(text)
    return payload if isinstance(payload, dict) else {}


def _vault_relative_path(vault_root: Path, value: str) -> Path:
    value = value.strip().strip("/\\")
    if not value:
        return vault_root
    candidate = Path(value)
    if candidate.is_absolute():
        return candidate
    return vault_root / candidate


def resolve_attachment_dir(vault_root: Path, canvas_folder: Path) -> Path | None:
    settings = load_obsidian_app_settings(vault_root)
    attachment_path = str(settings.get("attachmentFolderPath") or "").strip()
    new_file_location = str(settings.get("newFileLocation") or "").strip().lower()

    if attachment_path:
        return _vault_relative_path(vault_root, attachment_path)
    if new_file_location in {"root", "vault"}:
        return vault_root
    if new_file_location in {"current", "currentfolder", "samefolder"}:
        return canvas_folder
    return None


def resolve_vault_paths(canvas_folder: Path) -> VaultPaths:
    canvas_folder = Path(canvas_folder).resolve()
    vault_root = find_vault_root(canvas_folder)
    if not vault_root:
        raise ValueError(f"Canvas folder is not inside an Obsidian vault: {canvas_folder}")
    return VaultPaths(
        vault_root=vault_root,
        canvas_folder=canvas_folder,
        attachment_dir=resolve_attachment_dir(vault_root, canvas_folder),
    )
