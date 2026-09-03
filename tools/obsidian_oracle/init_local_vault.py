from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path
from typing import Any

try:  # Direct script execution keeps compatibility with existing oracle tools.
    from .common import (
        _is_link_or_reparse as is_link_or_reparse,
        load_config,
        obsidian_dir,
        require_oracle_vault,
        work_dir,
        write_json,
    )
except ImportError:  # pragma: no cover - exercised by ``python path\tool.py``.
    from common import (
        _is_link_or_reparse as is_link_or_reparse,
        load_config,
        obsidian_dir,
        require_oracle_vault,
        work_dir,
        write_json,
    )


def plugin_manifest(plugin_id: str, version: str) -> dict[str, str | bool]:
    if plugin_id == "advanced-canvas":
        return {
            "id": "advanced-canvas",
            "name": "Advanced Canvas",
            "version": version,
            "minAppVersion": "1.1.0",
            "description": "Supercharge your canvas experience! Create presentations, flowcharts and more!",
            "author": "Developer-Mike",
            "authorUrl": "https://github.com/Developer-Mike",
            "isDesktopOnly": False,
        }
    return {
        "id": plugin_id,
        "name": plugin_id,
        "version": version,
        "minAppVersion": "1.1.0",
        "description": "Oracle placeholder manifest. Install the real plugin for final screenshots.",
        "isDesktopOnly": False,
    }


def copy_plugin_runtime(plugin_id: str, source_plugins_dir: Path, target_plugins_dir: Path) -> bool:
    source = source_plugins_dir / plugin_id
    target = target_plugins_dir / plugin_id
    if not source.exists() or is_link_or_reparse(source):
        return False
    if target.exists() and is_link_or_reparse(target):
        raise RuntimeError(f"Cannot replace linked oracle plugin directory: {target}")
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(source, target)
    return True


def initialize_local_vault(
    *,
    config: dict[str, Any] | None = None,
    plugin_source: Path | None = None,
    vault_root: Path | str | None = None,
) -> Path:
    """Create the guarded project-local test vault and plugin manifests."""

    config = config or load_config()
    vault = require_oracle_vault(vault_root, config)
    obsidian = obsidian_dir(config)
    if obsidian.exists() or obsidian.is_symlink():
        if is_link_or_reparse(obsidian) or not obsidian.is_dir():
            raise RuntimeError(f"Oracle .obsidian path is not a regular directory: {obsidian}")
    vault.mkdir(parents=True, exist_ok=True)
    obsidian.mkdir(parents=True, exist_ok=True)
    work = work_dir(config)
    if work.exists() or work.is_symlink():
        if is_link_or_reparse(work) or not work.is_dir():
            raise RuntimeError(f"Oracle work path is not a regular directory: {work}")
    plugins_dir = obsidian / "plugins"
    if plugins_dir.exists() or plugins_dir.is_symlink():
        if is_link_or_reparse(plugins_dir) or not plugins_dir.is_dir():
            raise RuntimeError(f"Oracle plugins path is not a regular directory: {plugins_dir}")
    plugins_dir.mkdir(parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=True)

    enabled_plugins: list[str] = []
    plugins_file = obsidian / "community-plugins.json"
    if plugins_file.exists():
        if is_link_or_reparse(plugins_file) or not plugins_file.is_file():
            raise RuntimeError(f"Oracle enabled plugins file is not a regular file: {plugins_file}")
        existing = plugins_file.read_text(encoding="utf-8-sig").strip()
        if existing:
            loaded = json.loads(existing)
            if isinstance(loaded, list):
                enabled_plugins = [str(p) for p in loaded]

    for plugin_id, version in config.get("required_plugins", {}).items():
        if plugin_id not in enabled_plugins:
            enabled_plugins.append(plugin_id)

        copied = False
        if plugin_source:
            copied = copy_plugin_runtime(plugin_id, plugin_source, plugins_dir)

        plugin_dir = plugins_dir / plugin_id
        plugin_dir.mkdir(parents=True, exist_ok=True)
        manifest_path = plugin_dir / "manifest.json"
        if not manifest_path.exists():
            write_json(manifest_path, plugin_manifest(plugin_id, str(version)))

        if not copied and not (plugin_dir / "main.js").exists():
            (plugin_dir / "PLUGIN_RUNTIME_REQUIRED.txt").write_text(
                "Install or copy the real plugin runtime here before final Obsidian screenshot automation.\n",
                encoding="utf-8",
            )

    write_json(plugins_file, enabled_plugins)

    print(f"OK: initialized local oracle vault: {vault}")
    print(f"OK: work_dir={work}")
    return vault


def main() -> int:
    parser = argparse.ArgumentParser(description="Initialize the project-local Obsidian oracle vault.")
    parser.add_argument(
        "--plugin-source",
        type=Path,
        help="Optional path to an existing .obsidian/plugins directory to copy real plugin runtimes from.",
    )
    parser.add_argument(
        "--vault-root",
        type=Path,
        help="Must equal the oracle_config.json vault path; arbitrary user vaults are refused.",
    )
    args = parser.parse_args()
    initialize_local_vault(plugin_source=args.plugin_source, vault_root=args.vault_root)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

