"""Stage the daily-tools test board without overwriting previous manual edits."""

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


def stage_daily_fixture() -> Path:
    config = load_config()
    vault = require_oracle_vault(None, config)
    if not (vault / ".obsidian").is_dir():
        raise RuntimeError("Initialize the oracle vault before staging the daily board")
    target = staging_root(vault, config)
    canvas = target / "m1-daily.canvas"
    attachment = target / "m1-attachment.md"
    for path in (canvas, attachment):
        if _is_link_or_reparse(path) or (path.exists() and not path.is_file()):
            raise RuntimeError(f"Daily fixture target is not a regular file: {path}")
    source = TOOL_DIR / "fixtures" / "m0"
    document = json.loads((source / canvas.name).read_text(encoding="utf-8"))
    asset_path = (target.relative_to(vault) / attachment.name).as_posix()
    for node in document["nodes"]:
        if node.get("file") == "$ASSET/m1-attachment.md":
            node["file"] = asset_path
    payloads = {
        attachment: (source / attachment.name).read_bytes(),
        canvas: (json.dumps(document, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
    }
    created: list[Path] = []
    try:
        with tempfile.TemporaryDirectory(prefix=".daily-fixture-", dir=target) as temporary:
            for destination, payload in payloads.items():
                if destination.exists():
                    continue  # Keep manual edits across setup/deploy runs.
                staged = Path(temporary) / destination.name
                staged.write_bytes(payload)
                # Hard-link creation fails if another process creates the target;
                # unlike replace(), it cannot overwrite a concurrent manual edit.
                destination.hardlink_to(staged)
                created.append(destination)
    except Exception:
        for destination in reversed(created):
            destination.unlink()
        raise
    return canvas


def main() -> int:
    print(stage_daily_fixture())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
