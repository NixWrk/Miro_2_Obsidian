from __future__ import annotations

import argparse
import sys
from pathlib import Path

from common import load_config, vault_path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = REPO_ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from obsidian_plugin_setup import (  # noqa: E402
    ADVANCED_CANVAS_ID,
    ADVANCED_CANVAS_VERSION,
    install_advanced_canvas,
)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Install the hash-verified Advanced Canvas runtime into the oracle vault."
    )
    parser.add_argument("plugin", nargs="?", default=ADVANCED_CANVAS_ID)
    parser.add_argument(
        "--source-plugins-dir",
        type=Path,
        help="Copy a hash-verified runtime from an existing .obsidian/plugins directory.",
    )
    parser.add_argument("--version", help="Pinned release version from oracle_config.json.")
    args = parser.parse_args()

    if args.plugin != ADVANCED_CANVAS_ID:
        raise SystemExit(f"Unsupported oracle plugin: {args.plugin}")

    config = load_config()
    version = args.version or str(
        config.get("required_plugins", {}).get(ADVANCED_CANVAS_ID, ADVANCED_CANVAS_VERSION)
    )
    target = install_advanced_canvas(
        vault_path(config),
        source_plugins_dir=args.source_plugins_dir,
        version=version,
        logger=print,
    )
    print(f"OK: installed hash-verified {ADVANCED_CANVAS_ID} runtime at {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
