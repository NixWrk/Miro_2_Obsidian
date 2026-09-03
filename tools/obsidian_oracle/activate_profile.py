"""Activate one M0 compatibility profile in the guarded oracle vault."""

from __future__ import annotations

import argparse
from pathlib import Path

try:  # Direct script execution keeps compatibility with existing oracle tools.
    from .compatibility import profile_ids
    from .profile import activate_profile
except ImportError:  # pragma: no cover - exercised by ``python path\tool.py``.
    from compatibility import profile_ids
    from profile import activate_profile


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Atomically stage and activate one local M0 Obsidian compatibility profile."
    )
    parser.add_argument("profile", choices=profile_ids())
    parser.add_argument(
        "--vault-root",
        type=Path,
        help="Must equal the oracle_config.json vault path; arbitrary user vaults are refused.",
    )
    parser.add_argument(
        "--preserve-plugin",
        action="append",
        default=[],
        help="Explicit safe unrelated plugin ID to retain in community-plugins.json (repeatable).",
    )
    args = parser.parse_args()
    result = activate_profile(
        args.profile,
        args.vault_root,
        preserve_plugin_ids=args.preserve_plugin,
    )
    print(f"OK: activated profile={result.profile.id}")
    print(f"canvas={result.canvas_path}")
    print("enabled_plugins=" + ",".join(result.enabled_plugins_after))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
