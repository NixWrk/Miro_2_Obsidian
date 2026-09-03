from __future__ import annotations

import argparse
import json
from pathlib import Path

try:  # Direct script execution keeps compatibility with existing oracle tools.
    from .common import (
        _is_link_or_reparse as is_link_or_reparse,
        load_config,
        obsidian_dir,
        require_oracle_vault,
        resolve_path,
        work_dir,
    )
    from .compatibility import load_compatibility_matrix
    from .profile import check_profile
except ImportError:  # pragma: no cover - exercised by ``python path\tool.py``.
    from common import (
        _is_link_or_reparse as is_link_or_reparse,
        load_config,
        obsidian_dir,
        require_oracle_vault,
        resolve_path,
        work_dir,
    )
    from compatibility import load_compatibility_matrix
    from profile import check_profile


def fail(message: str) -> None:
    print(f"FAIL: {message}")
    raise SystemExit(1)


def check_runtime(
    plugins_dir: Path,
    plugin_id: str,
    *,
    require_runtime: bool,
) -> None:
    """Check the standard runtime assets, including local miro-canvas."""

    plugin_path = plugins_dir / plugin_id
    runtime_assets = ("manifest.json", "main.js", "styles.css")
    missing = [
        name
        for name in runtime_assets
        if is_link_or_reparse(plugin_path / name)
        or not (plugin_path / name).is_file()
    ]
    if require_runtime and missing:
        fail(f"Missing plugin runtime asset(s) for {plugin_id}: {', '.join(missing)}")
    if missing:
        print(
            f"WARN: {plugin_id} runtime asset(s) are not installed: {', '.join(missing)}; "
            "final Obsidian screenshots need the real plugin"
        )
        return
    print(f"OK: {plugin_id} runtime assets are installed")


def main() -> int:
    parser = argparse.ArgumentParser(description="Check the Obsidian oracle vault environment.")
    parser.add_argument(
        "--strict-runtime",
        action="store_true",
        help="Require real plugin runtime files such as main.js, not just manifests.",
    )
    parser.add_argument(
        "--profile",
        help="Verify one activated M0 profile (native-only, miro-canvas-only, advanced-only, or both).",
    )
    parser.add_argument(
        "--preserve-plugin",
        action="append",
        default=[],
        help="Explicit safe unrelated plugin ID allowed by --profile (repeatable).",
    )
    args = parser.parse_args()

    config = load_config()
    try:
        vault = require_oracle_vault(None, config)
    except ValueError as exc:
        fail(str(exc))
    work = work_dir(config)
    obsidian = obsidian_dir(config)
    plugins_file = obsidian / "community-plugins.json"
    plugins_dir = obsidian / "plugins"

    if not vault.exists():
        fail(f"Vault does not exist: {vault}")
    if not obsidian.exists() or is_link_or_reparse(obsidian):
        fail(f"Missing .obsidian directory: {obsidian}")
    if not work.exists() or is_link_or_reparse(work):
        fail(f"Missing oracle work folder: {work}")
    if not plugins_file.exists() or is_link_or_reparse(plugins_file):
        fail(f"Missing community plugins file: {plugins_file}")

    try:
        enabled_plugins = json.loads(plugins_file.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        fail(f"Invalid community plugins file {plugins_file}: {exc}")
    if not isinstance(enabled_plugins, list) or any(
        not isinstance(plugin_id, str) or not plugin_id for plugin_id in enabled_plugins
    ):
        fail("community-plugins.json must contain a list")

    matrix_config = config.get("compatibility_matrix")
    if matrix_config:
        matrix_path = resolve_path(str(matrix_config))
        if not matrix_path.is_file():
            fail(f"Missing compatibility matrix: {matrix_path}")
        try:
            profiles = load_compatibility_matrix(matrix_path)
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            fail(f"Invalid compatibility matrix {matrix_path}: {exc}")
        print(f"OK: compatibility matrix has {len(profiles)} offline profiles")

    profile_result = None
    if args.profile:
        try:
            profile_result = check_profile(
                args.profile,
                vault,
                preserve_plugin_ids=args.preserve_plugin,
                require_runtime=args.strict_runtime,
            )
        except (OSError, ValueError, RuntimeError) as exc:
            fail(str(exc))
        print(
            f"OK: profile {profile_result.profile.id} enabled plugins="
            + ",".join(profile_result.enabled_plugins)
        )
        for runtime_error in profile_result.runtime_missing:
            print(f"WARN: {runtime_error}")

    for plugin_id, expected_version in config.get("required_plugins", {}).items():
        manifest_path = plugins_dir / plugin_id / "manifest.json"
        if not manifest_path.exists() or is_link_or_reparse(manifest_path):
            fail(f"Missing plugin manifest: {manifest_path}")

        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError) as exc:
            fail(f"Invalid plugin manifest {manifest_path}: {exc}")
        if not isinstance(manifest, dict):
            fail(f"Plugin manifest must be an object: {manifest_path}")
        actual_version = str(manifest.get("version", ""))
        if expected_version and actual_version != str(expected_version):
            fail(
                f"Plugin {plugin_id} version mismatch: "
                f"expected {expected_version}, got {actual_version}"
            )

        print(f"OK: {plugin_id} {actual_version} is installed")
        # Without --profile this is the vault-wide installed-runtime check.
        # Profile verification above owns the active profile's runtime check,
        # so a native-only profile is not made impossible by an unused plugin.
        require_runtime = (
            args.strict_runtime or config.get("require_plugin_runtime", False)
        ) and profile_result is None
        check_runtime(
            plugins_dir,
            plugin_id,
            require_runtime=require_runtime,
        )
        state = "enabled" if plugin_id in enabled_plugins else "disabled"
        print(f"OK: {plugin_id} active-state={state} (runtime check is independent)")

    print(f"OK: vault={vault}")
    print(f"OK: work_dir={work}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
