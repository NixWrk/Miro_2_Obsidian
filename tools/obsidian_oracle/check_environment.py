from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


TOOL_DIR = Path(__file__).resolve().parent
CONFIG_PATH = TOOL_DIR / "oracle_config.json"


def load_config() -> dict[str, Any]:
    with CONFIG_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


def fail(message: str) -> None:
    print(f"FAIL: {message}")
    raise SystemExit(1)


def main() -> int:
    config = load_config()
    vault_path = Path(config["vault_path"])
    work_dir = vault_path / config["work_folder"]
    obsidian_dir = vault_path / ".obsidian"
    plugins_file = obsidian_dir / "community-plugins.json"
    plugins_dir = obsidian_dir / "plugins"

    if not vault_path.exists():
        fail(f"Vault does not exist: {vault_path}")
    if not obsidian_dir.exists():
        fail(f"Missing .obsidian directory: {obsidian_dir}")
    if not work_dir.exists():
        fail(f"Missing oracle work folder: {work_dir}")
    if not plugins_file.exists():
        fail(f"Missing community plugins file: {plugins_file}")

    enabled_plugins = json.loads(plugins_file.read_text(encoding="utf-8-sig"))
    if not isinstance(enabled_plugins, list):
        fail("community-plugins.json must contain a list")

    for plugin_id, expected_version in config.get("required_plugins", {}).items():
        if plugin_id not in enabled_plugins:
            fail(f"Required plugin is not enabled: {plugin_id}")

        manifest_path = plugins_dir / plugin_id / "manifest.json"
        if not manifest_path.exists():
            fail(f"Missing plugin manifest: {manifest_path}")

        manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
        actual_version = str(manifest.get("version", ""))
        if expected_version and actual_version != str(expected_version):
            fail(
                f"Plugin {plugin_id} version mismatch: "
                f"expected {expected_version}, got {actual_version}"
            )

        print(f"OK: {plugin_id} {actual_version} is enabled")

    print(f"OK: vault={vault_path}")
    print(f"OK: work_dir={work_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

