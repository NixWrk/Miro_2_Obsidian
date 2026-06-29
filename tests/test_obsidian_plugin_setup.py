from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"

sys.path.insert(0, str(SCRIPTS_DIR))

from obsidian_plugin_setup import (  # noqa: E402
    ADVANCED_CANVAS_ID,
    ZOOM_UNLOCK_ID,
    download_release_asset,
    plugin_has_runtime,
    setup_obsidian_plugins,
)


class ObsidianPluginSetupTests(unittest.TestCase):
    def test_setup_enables_existing_advanced_canvas_and_local_zoom_plugin(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            advanced = vault / ".obsidian" / "plugins" / ADVANCED_CANVAS_ID
            advanced.mkdir(parents=True)
            (advanced / "manifest.json").write_text('{"id":"advanced-canvas"}', encoding="utf-8")
            (advanced / "main.js").write_text("// installed\n", encoding="utf-8")

            result = setup_obsidian_plugins(vault)

            enabled = json.loads((vault / ".obsidian" / "community-plugins.json").read_text(encoding="utf-8"))
            zoom = vault / ".obsidian" / "plugins" / ZOOM_UNLOCK_ID
            self.assertTrue(plugin_has_runtime(vault, ADVANCED_CANVAS_ID))
            self.assertTrue((zoom / "manifest.json").is_file())
            self.assertTrue((zoom / "main.js").is_file())
            self.assertIn(ADVANCED_CANVAS_ID, enabled)
            self.assertIn(ZOOM_UNLOCK_ID, enabled)
            self.assertEqual(result.installed, [ADVANCED_CANVAS_ID, ZOOM_UNLOCK_ID])

    def test_setup_can_copy_advanced_canvas_from_existing_plugins_dir(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source_plugins" / ADVANCED_CANVAS_ID
            source.mkdir(parents=True)
            (source / "manifest.json").write_text('{"id":"advanced-canvas"}', encoding="utf-8")
            (source / "main.js").write_text("// copied\n", encoding="utf-8")

            setup_obsidian_plugins(root / "vault", advanced_source_plugins_dir=root / "source_plugins")

            target = root / "vault" / ".obsidian" / "plugins" / ADVANCED_CANVAS_ID
            self.assertEqual((target / "main.js").read_text(encoding="utf-8"), "// copied\n")

    def test_download_release_asset_tries_plain_and_v_prefixed_tags(self) -> None:
        calls: list[str] = []

        def fake_download(url: str, target: Path) -> None:
            calls.append(url)
            if "/download/6.0.1/" in url:
                raise OSError("missing plain tag")
            target.write_text("asset", encoding="utf-8")

        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "main.js"
            with patch("obsidian_plugin_setup._download", side_effect=fake_download):
                url = download_release_asset("owner/repo", "6.0.1", "main.js", target)
            text = target.read_text(encoding="utf-8")

        self.assertEqual(len(calls), 2)
        self.assertIn("/download/v6.0.1/main.js", url)
        self.assertEqual(text, "asset")


if __name__ == "__main__":
    unittest.main()
