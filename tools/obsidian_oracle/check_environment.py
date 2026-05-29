from __future__ import annotations

import json

from common import load_config, obsidian_dir, vault_path, work_dir


def fail(message: str) -> None:
    print(f"FAIL: {message}")
    raise SystemExit(1)


def main() -> int:
    config = load_config()
    vault = vault_path(config)
    work = work_dir(config)
    obsidian = obsidian_dir(config)
    plugins_file = obsidian / "community-plugins.json"
    plugins_dir = obsidian / "plugins"

    if not vault.exists():
        fail(f"Vault does not exist: {vault}")
    if not obsidian.exists():
        fail(f"Missing .obsidian directory: {obsidian}")
    if not work.exists():
        fail(f"Missing oracle work folder: {work}")
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
        if config.get("require_plugin_runtime", False):
            if not (plugins_dir / plugin_id / "main.js").exists():
                fail(f"Missing plugin runtime main.js for {plugin_id}")
        elif not (plugins_dir / plugin_id / "main.js").exists():
            print(f"WARN: {plugin_id} runtime main.js is not installed; final Obsidian screenshots need the real plugin")

    print(f"OK: vault={vault}")
    print(f"OK: work_dir={work}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
