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
        self.assertIn('const EXPORTER_VERSION = "20260611-deep-table"', js)
        self.assertIn("exporter_version: EXPORTER_VERSION", js)
        self.assertIn("function toPlain", js)
        self.assertIn("TABLE_DIAGNOSTIC_TYPES", js)
        self.assertIn("function deepInspectTableLikeItem", js)
        self.assertIn("Object.getOwnPropertyNames", js)
        self.assertIn("known_field_reads", js)
        self.assertIn("prototype_chain", js)
        self.assertIn("diagnostics: buildDiagnostics(items)", js)
        self.assertIn("diagnostics: buildDiagnostics(selection)", js)

    def test_index_registers_miro_toolbar_icon(self) -> None:
        html = (EXPORTER_DIR / "index.html").read_text(encoding="utf-8")

        self.assertIn("https://miro.com/app/static/sdk/v2/miro.js", html)
        self.assertIn('miro.board.ui.on("icon:click"', html)
        self.assertIn("miro.board.ui.openPanel", html)
        self.assertIn("panel-20260611-deep-table.html", html)
        self.assertIn("Exporter version: 20260611-deep-table", html)

    def test_versioned_entrypoint_registers_miro_toolbar_icon(self) -> None:
        html = (EXPORTER_DIR / "index-20260611-deep-table.html").read_text(encoding="utf-8")

        self.assertIn("https://miro.com/app/static/sdk/v2/miro.js", html)
        self.assertIn('miro.board.ui.on("icon:click"', html)
        self.assertIn("miro.board.ui.openPanel", html)
        self.assertIn("panel-20260611-deep-table.html", html)
        self.assertIn("Exporter version: 20260611-deep-table", html)

    def test_panel_loads_miro_sdk_and_local_exporter(self) -> None:
        html = (EXPORTER_DIR / "panel.html").read_text(encoding="utf-8")

        self.assertIn("https://miro.com/app/static/sdk/v2/miro.js", html)
        self.assertIn("./exporter.js", html)
        self.assertIn("create-generated-probe", html)
        self.assertIn("export-board", html)
        self.assertIn("export-selection", html)
        self.assertIn("./exporter.js?v=20260611-deep-table", html)
        self.assertIn("Exporter version: 20260611-deep-table", html)

    def test_versioned_panel_loads_miro_sdk_and_local_exporter(self) -> None:
        html = (EXPORTER_DIR / "panel-20260611-deep-table.html").read_text(encoding="utf-8")

        self.assertIn("https://miro.com/app/static/sdk/v2/miro.js", html)
        self.assertIn("create-generated-probe", html)
        self.assertIn("export-board", html)
        self.assertIn("export-selection", html)
        self.assertIn("./exporter.js?v=20260611-deep-table", html)
        self.assertIn("Exporter version: 20260611-deep-table", html)

    def test_toolbar_icons_and_manifest_are_present(self) -> None:
        outline = (EXPORTER_DIR / "icon-outline.svg").read_text(encoding="utf-8")
        color = (EXPORTER_DIR / "icon-color.svg").read_text(encoding="utf-8")
        manifest = (EXPORTER_DIR / "manifest.example.yml").read_text(encoding="utf-8")

        self.assertIn("<svg", outline)
        self.assertIn("<svg", color)
        self.assertNotIn(" role=", outline)
        self.assertNotIn(" aria-", outline)
        self.assertNotIn(" role=", color)
        self.assertNotIn(" aria-", color)
        self.assertIn("sdkUri: http://localhost:8766/index-20260611-deep-table.html", manifest)
        self.assertIn("Use this URI for SDK authorization", manifest)
        self.assertIn("boards:read", manifest)
        self.assertIn("boards:write", manifest)

    def test_readme_warns_about_team_and_duplicate_apps(self) -> None:
        readme = (EXPORTER_DIR / "README.md").read_text(encoding="utf-8")

        self.assertIn("same team as the target board", readme)
        self.assertIn("If several", readme)
        self.assertIn("Profile settings", readme)
        self.assertIn("http://localhost:8766/index-20260611-deep-table.html", readme)
        self.assertIn("serve_no_cache.py --port 8766", readme)
        self.assertIn("exporter_version", readme)
        self.assertIn("+ More apps", readme)
        self.assertIn("+ More tools", readme)
        self.assertIn("app-visible team", readme)
        self.assertIn("same board", readme)
        self.assertIn("Creating more boards is not", readme)
        self.assertIn("allowed in this plan", readme)
        self.assertIn("--board-id", readme)
        self.assertIn("left-hand app toolbar", readme)
        self.assertIn("monochrome outline icon", readme)


if __name__ == "__main__":
    unittest.main()
