"""Build the deterministic project-local M0 Obsidian oracle vault."""

from __future__ import annotations

import argparse
from pathlib import Path

try:  # Direct script execution keeps compatibility with existing oracle tools.
    from .init_local_vault import initialize_local_vault
    from .install_miro_canvas_runtime import install_miro_canvas_runtime
    from .stage_compatibility_fixture import stage_all_profiles
    from .open_local_vault import inspect_registration, registration_instructions
except ImportError:  # pragma: no cover - exercised by ``python path\tool.py``.
    from init_local_vault import initialize_local_vault
    from install_miro_canvas_runtime import install_miro_canvas_runtime
    from stage_compatibility_fixture import stage_all_profiles
    from open_local_vault import inspect_registration, registration_instructions


def setup_m0_vault(
    vault_root: Path | str | None = None,
    *,
    source_plugin_dir: Path | str | None = None,
    skip_runtime: bool = False,
) -> tuple[Path, tuple[Path, ...]]:
    """Initialize, optionally install, and stage the complete M0 test vault."""

    vault = initialize_local_vault(vault_root=vault_root)
    if not skip_runtime:
        install_miro_canvas_runtime(vault, source_plugin_dir=source_plugin_dir, logger=print)
    paths = stage_all_profiles(vault)
    return vault, paths


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Initialize the local M0 Obsidian oracle, install miro-canvas, and stage all compatibility profiles."
    )
    parser.add_argument(
        "--vault-root",
        type=Path,
        help="Must equal the oracle_config.json vault path; arbitrary user vaults are refused.",
    )
    parser.add_argument(
        "--source-plugin-dir",
        type=Path,
        help="Built miro-canvas directory (defaults to plugins/miro-canvas).",
    )
    parser.add_argument(
        "--skip-runtime",
        action="store_true",
        help="Only initialize and stage fixtures; useful before npm build is available.",
    )
    args = parser.parse_args()
    vault, paths = setup_m0_vault(
        args.vault_root,
        source_plugin_dir=args.source_plugin_dir,
        skip_runtime=args.skip_runtime,
    )
    print(f"OK: M0 oracle vault={vault}")
    for path in paths:
        print(path)
    registration = inspect_registration(vault)
    print(f"Obsidian vault registration: {registration.status}")
    if registration.status != "registered":
        print(registration_instructions(vault))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
