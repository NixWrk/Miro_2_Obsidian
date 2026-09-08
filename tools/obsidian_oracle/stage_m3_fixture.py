"""Stage the complete M1-M3 acceptance board without overwriting manual edits."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

try:
    from .common import TOOL_DIR, _is_link_or_reparse, load_config, require_oracle_vault
    from .stage_compatibility_fixture import staging_root
except ImportError:  # pragma: no cover - direct script execution
    from common import TOOL_DIR, _is_link_or_reparse, load_config, require_oracle_vault
    from stage_compatibility_fixture import staging_root


FIXTURE_NAME = "m3-all-features.canvas"
DOCUMENT_ASSET = "m1-attachment.md"
IMAGE_ASSET = "m3-image.svg"


def stage_m3_fixture() -> Path:
    config = load_config()
    vault = require_oracle_vault(None, config)
    if not (vault / ".obsidian").is_dir():
        raise RuntimeError("Initialize the oracle vault before staging the M1-M3 board")

    target = staging_root(vault, config)
    canvas = target / FIXTURE_NAME
    document_asset = target / DOCUMENT_ASSET
    image_asset = target / IMAGE_ASSET
    for path in (canvas, document_asset, image_asset):
        if _is_link_or_reparse(path) or (path.exists() and not path.is_file()):
            raise RuntimeError(f"M1-M3 fixture target is not a regular file: {path}")

    fixture_root = TOOL_DIR / "fixtures"
    document = json.loads((fixture_root / FIXTURE_NAME).read_text(encoding="utf-8"))
    asset_root = target.relative_to(vault).as_posix()
    substitutions = {
        "$ASSET/m1-attachment.md": f"{asset_root}/{DOCUMENT_ASSET}",
        "$ASSET/m3-image.svg": f"{asset_root}/{IMAGE_ASSET}",
    }
    for node in document["nodes"]:
        path = node.get("file")
        if path in substitutions:
            node["file"] = substitutions[path]

    payloads = {
        document_asset: (fixture_root / "m0" / DOCUMENT_ASSET).read_bytes(),
        image_asset: (TOOL_DIR.parent / "miro_websdk_exporter" / "icon-color.svg").read_bytes(),
        canvas: (json.dumps(document, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
    }
    created: list[Path] = []
    try:
        with tempfile.TemporaryDirectory(prefix=".m3-fixture-", dir=target) as temporary:
            for destination, payload in payloads.items():
                if destination.exists():
                    continue
                staged = Path(temporary) / destination.name
                staged.write_bytes(payload)
                destination.hardlink_to(staged)
                created.append(destination)
    except Exception:
        for destination in reversed(created):
            destination.unlink()
        raise
    return canvas


def main() -> int:
    print(stage_m3_fixture())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
