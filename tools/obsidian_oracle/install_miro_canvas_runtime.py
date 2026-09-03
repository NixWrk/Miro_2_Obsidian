"""Install the locally built ``miro-canvas`` runtime into the oracle vault.

This installer is intentionally project-local.  It never downloads a release
and refuses every vault path except the path configured in ``oracle_config``.
The runtime directory and the enabled-plugin list are activated as one small
transaction so a failed validation or settings write restores the previous
runtime.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import stat
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

try:  # Direct script execution keeps compatibility with existing oracle tools.
    from .common import REPO_ROOT, load_config, require_oracle_vault
except ImportError:  # pragma: no cover - exercised by ``python path\tool.py``.
    from common import REPO_ROOT, load_config, require_oracle_vault


PLUGIN_ID = "miro-canvas"
PLUGIN_VERSION = "0.1.0"
RELEASE_ASSETS = ("manifest.json", "main.js", "styles.css")


def _is_link_or_reparse(path: Path) -> bool:
    if path.is_symlink():
        return True
    try:
        attributes = path.stat(follow_symlinks=False).st_file_attributes
    except (AttributeError, FileNotFoundError, OSError):
        return False
    return bool(attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def _require_regular_directory(path: Path, *, label: str) -> None:
    if _is_link_or_reparse(path) or not path.is_dir():
        raise RuntimeError(f"{label} is not a regular directory: {path}")


def _require_regular_file(path: Path, *, label: str) -> None:
    if _is_link_or_reparse(path) or not path.is_file() or path.stat().st_size == 0:
        raise RuntimeError(f"{label} is missing, empty, or linked: {path}")


def _read_manifest(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        raise RuntimeError(f"Invalid {path.name}: {exc}") from exc
    if not isinstance(payload, dict):
        raise RuntimeError(f"{path} must contain a JSON object")
    return payload


def validate_miro_canvas_runtime(
    runtime_dir: Path,
    *,
    expected_version: str = PLUGIN_VERSION,
) -> None:
    """Validate all files required by an Obsidian community plugin runtime."""

    runtime_dir = Path(runtime_dir)
    _require_regular_directory(runtime_dir, label="miro-canvas runtime")
    for asset in RELEASE_ASSETS:
        _require_regular_file(runtime_dir / asset, label=f"miro-canvas {asset}")
    manifest = _read_manifest(runtime_dir / "manifest.json")
    if manifest.get("id") != PLUGIN_ID:
        raise RuntimeError(f"miro-canvas manifest id is not {PLUGIN_ID}: {runtime_dir / 'manifest.json'}")
    if expected_version and str(manifest.get("version", "")) != expected_version:
        raise RuntimeError(
            f"miro-canvas manifest version is not {expected_version}: {runtime_dir / 'manifest.json'}"
        )


def _plugin_dir(vault_root: Path) -> Path:
    return Path(vault_root) / ".obsidian" / "plugins" / PLUGIN_ID


def _read_enabled(path: Path) -> tuple[list[str], bytes | None]:
    if path.is_symlink() or _is_link_or_reparse(path):
        raise RuntimeError(f"Enabled plugins file is linked or reparse: {path}")
    if not path.exists():
        return [], None
    _require_regular_file(path, label="Enabled plugins file")
    snapshot = path.read_bytes()
    try:
        payload = json.loads(snapshot.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise RuntimeError(f"Enabled plugins file is not valid JSON: {path}") from exc
    if not isinstance(payload, list) or any(
        not isinstance(plugin_id, str) or not plugin_id for plugin_id in payload
    ):
        raise RuntimeError(f"Enabled plugins must be a JSON array of non-empty strings: {path}")
    return list(payload), snapshot


def _atomic_write_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            prefix=f".{path.name}.",
            suffix=".tmp",
            dir=path.parent,
            delete=False,
        ) as handle:
            temporary = Path(handle.name)
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(path)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _atomic_write_enabled(path: Path, enabled: list[str]) -> None:
    _atomic_write_bytes(
        path,
        (json.dumps(enabled, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
    )


def _remove_runtime(path: Path) -> None:
    """Remove only the newly activated regular runtime during rollback."""

    if not path.exists() and not path.is_symlink():
        return
    if _is_link_or_reparse(path):
        path.unlink(missing_ok=True)
    elif path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


@contextmanager
def _activate_runtime(
    staged: Path,
    target: Path,
    *,
    expected_version: str,
) -> Iterator[None]:
    """Atomically swap one runtime directory, retaining a rollback copy."""

    target.parent.mkdir(parents=True, exist_ok=True)
    _require_regular_directory(target.parent, label="Plugin directory")
    if target.exists() or target.is_symlink():
        _require_regular_directory(target, label="Existing miro-canvas runtime")

    with tempfile.TemporaryDirectory(prefix=f".{PLUGIN_ID}-backup-", dir=target.parent) as backup_root:
        backup = Path(backup_root) / "previous"
        had_previous = target.exists()
        if had_previous:
            target.rename(backup)
        try:
            staged.rename(target)
            validate_miro_canvas_runtime(target, expected_version=expected_version)
            yield
        except Exception:
            _remove_runtime(target)
            if had_previous and backup.exists():
                backup.rename(target)
            raise


def _restore_enabled(path: Path, snapshot: bytes | None) -> None:
    if snapshot is None:
        if path.exists() or path.is_symlink():
            if _is_link_or_reparse(path):
                path.unlink(missing_ok=True)
            elif path.is_file():
                path.unlink()
            else:
                raise RuntimeError(f"Cannot remove unexpected enabled plugins path: {path}")
        return
    _atomic_write_bytes(path, snapshot)


def _require_oracle_vault(candidate: Path | str | None, config: dict[str, Any]) -> Path:
    vault = require_oracle_vault(candidate, config)
    if not vault.exists():
        raise RuntimeError(
            f"Oracle vault does not exist: {vault}. Run init_local_vault.py first."
        )
    obsidian = vault / ".obsidian"
    _require_regular_directory(obsidian, label="Oracle .obsidian directory")
    plugins = obsidian / "plugins"
    if plugins.exists() or plugins.is_symlink():
        _require_regular_directory(plugins, label="Oracle plugins directory")
    return vault


def install_miro_canvas_runtime(
    vault_root: Path | str | None = None,
    *,
    source_plugin_dir: Path | str | None = None,
    version: str | None = None,
    logger: Any | None = None,
) -> Path:
    """Install a built local runtime and enable it in the oracle vault.

    ``source_plugin_dir`` defaults to the repository plugin directory.  Only
    the three Obsidian release assets are copied; no source tree is linked into
    the vault.  The return value is the activated target directory.
    """

    config = load_config()
    vault = _require_oracle_vault(vault_root, config)
    expected_version = version or str(config.get("required_plugins", {}).get(PLUGIN_ID, PLUGIN_VERSION))
    source = Path(source_plugin_dir or (REPO_ROOT / "plugins" / PLUGIN_ID)).expanduser().absolute()
    validate_miro_canvas_runtime(source, expected_version=expected_version)

    plugins = vault / ".obsidian" / "plugins"
    plugins.mkdir(parents=True, exist_ok=True)
    _require_regular_directory(plugins, label="Oracle plugins directory")
    target = plugins / PLUGIN_ID
    enabled_path = vault / ".obsidian" / "community-plugins.json"
    enabled, enabled_snapshot = _read_enabled(enabled_path)

    with tempfile.TemporaryDirectory(prefix=f".{PLUGIN_ID}-stage-", dir=plugins) as stage_root:
        staged = Path(stage_root) / PLUGIN_ID
        staged.mkdir()
        for asset in RELEASE_ASSETS:
            shutil.copy2(source / asset, staged / asset)
        validate_miro_canvas_runtime(staged, expected_version=expected_version)

        with _activate_runtime(staged, target, expected_version=expected_version):
            try:
                if PLUGIN_ID not in enabled:
                    enabled.append(PLUGIN_ID)
                _atomic_write_enabled(enabled_path, enabled)
                enabled_after, _ = _read_enabled(enabled_path)
                if PLUGIN_ID not in enabled_after:
                    raise RuntimeError("miro-canvas was not enabled after atomic settings write")
            except Exception:
                _restore_enabled(enabled_path, enabled_snapshot)
                raise

    if logger:
        logger(f"Installed local {PLUGIN_ID} runtime at {target}")
    return target


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Install the locally built miro-canvas runtime into the project-local Obsidian oracle vault."
    )
    parser.add_argument(
        "--vault-root",
        type=Path,
        help="Must equal the oracle_config.json vault path; arbitrary user vaults are refused.",
    )
    parser.add_argument(
        "--source-plugin-dir",
        type=Path,
        help="Built plugin directory (defaults to plugins/miro-canvas).",
    )
    parser.add_argument("--version", help=f"Expected manifest version (default: {PLUGIN_VERSION}).")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    target = install_miro_canvas_runtime(
        args.vault_root,
        source_plugin_dir=args.source_plugin_dir,
        version=args.version,
        logger=print,
    )
    print(target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
