from __future__ import annotations

import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
EXPORTER_DIR = REPO_ROOT / "tools" / "miro_websdk_exporter"


class MiroWebsdkExporterAssetTests(unittest.TestCase):
    def test_exporter_calls_board_and_selection_apis(self) -> None:
        js = (EXPORTER_DIR / "exporter.js").read_text(encoding="utf-8")

        self.assertIn("miro.board.get()", js)
        self.assertIn("miro.board.getSelection()", js)
        self.assertIn("function createGeneratedProbeItems", js)
        self.assertIn('requireBoardMethod("createText")', js)
        self.assertIn('requireBoardMethod("createFrame")', js)
        self.assertIn('requireBoardMethod("createShape")', js)
        self.assertIn('requireBoardMethod("createStickyNote")', js)
        self.assertIn('requireBoardMethod("createCard")', js)
        self.assertIn('requireBoardMethod("createAppCard")', js)
        self.assertIn('requireBoardMethod("createConnector")', js)
        self.assertIn('requireBoardMethod("createEmbed")', js)
        self.assertIn('requireBoardMethod("createImage")', js)
        self.assertIn('requireBoardMethod("createPreview")', js)
        self.assertIn('requireBoardMethod("createTag")', js)
        self.assertIn('requireBoardMethod("group")', js)
        self.assertIn("function requireExperimentalMethod", js)
        self.assertIn('requireExperimentalMethod("createMindmapNode")', js)
        self.assertIn("WEBSDK_SHAPE_TYPES", js)
        self.assertIn("STICKY_COLORS", js)
        self.assertIn("CONNECTOR_SHAPES", js)
        self.assertIn("CONNECTOR_CAPS", js)
        self.assertIn("image_data_url", js)
        self.assertIn("embed_inline", js)
        self.assertIn('source_surface: "web_sdk"', js)
        self.assertIn("function toPlain", js)

    def test_index_loads_miro_sdk_and_local_exporter(self) -> None:
        html = (EXPORTER_DIR / "index.html").read_text(encoding="utf-8")

        self.assertIn("https://miro.com/app/static/sdk/v2/miro.js", html)
        self.assertIn("./exporter.js", html)
        self.assertIn("create-generated-probe", html)
        self.assertIn("export-board", html)
        self.assertIn("export-selection", html)


if __name__ == "__main__":
    unittest.main()
