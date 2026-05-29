from __future__ import annotations

import argparse
import shutil
from pathlib import Path

from common import load_config, obsidian_dir, vault_path, work_dir, write_json


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
    if not source.exists():
        return False
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(source, target)
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Initialize the project-local Obsidian oracle vault.")
    parser.add_argument(
        "--plugin-source",
        type=Path,
        help="Optional path to an existing .obsidian/plugins directory to copy real plugin runtimes from.",
    )
    args = parser.parse_args()

    config = load_config()
    vault = vault_path(config)
    work = work_dir(config)
    obsidian = obsidian_dir(config)
    plugins_dir = obsidian / "plugins"
    plugins_dir.mkdir(parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=True)

    enabled_plugins: list[str] = []
    plugins_file = obsidian / "community-plugins.json"
    if plugins_file.exists():
        existing = plugins_file.read_text(encoding="utf-8-sig").strip()
        if existing:
            import json

            loaded = json.loads(existing)
            if isinstance(loaded, list):
                enabled_plugins = [str(p) for p in loaded]

    for plugin_id, version in config.get("required_plugins", {}).items():
        if plugin_id not in enabled_plugins:
            enabled_plugins.append(plugin_id)

        copied = False
        if args.plugin_source:
            copied = copy_plugin_runtime(plugin_id, args.plugin_source, plugins_dir)

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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

