from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

from tools.obsidian_oracle import stage_daily_fixture as staging


def test_daily_board_has_local_asset_and_setup_preserves_manual_edits(tmp_path: Path) -> None:
    vault = tmp_path / "oracle"
    (vault / ".obsidian").mkdir(parents=True)
    config = {"vault_path": str(vault), "work_folder": "Smoke", "oracle_subfolder": "checks"}
    with patch.object(staging, "load_config", return_value=config):
        canvas = staging.stage_daily_fixture()
        document = json.loads(canvas.read_text(encoding="utf-8"))
        for node in document["nodes"]:
            if node.get("type") == "file":
                assert (vault / node["file"]).is_file()
                assert node["file"].startswith("Smoke/checks/")
        attachment = canvas.parent / "m1-attachment.md"
        canvas.write_text('{"nodes":[],"edges":[],"manual":true}', encoding="utf-8")
        attachment.write_text("Manual edit", encoding="utf-8")
        staging.stage_daily_fixture()
    assert json.loads(canvas.read_text(encoding="utf-8"))["manual"] is True
    assert attachment.read_text(encoding="utf-8") == "Manual edit"
