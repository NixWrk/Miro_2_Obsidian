from __future__ import annotations

import importlib.util
import socket
import threading
import unittest
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.request import urlopen


REPO_ROOT = Path(__file__).resolve().parents[1]
EXPORTER_DIR = REPO_ROOT / "tools" / "miro_websdk_exporter"


def load_server_module():
    path = EXPORTER_DIR / "serve_no_cache.py"
    spec = importlib.util.spec_from_file_location("miro_websdk_server", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class MiroWebsdkExporterAssetTests(unittest.TestCase):
    def test_server_maps_sdk_callback_to_current_entrypoint(self) -> None:
        server = load_server_module()

        self.assertEqual(
            server.resolve_request_path("/callback?_miro=1.2.3&_sdk=stable"),
            "/index.html?_miro=1.2.3&_sdk=stable",
        )
        self.assertEqual(
            server.resolve_request_path("/callback?code=one-time-code"),
            "/callback?code=one-time-code",
        )
        for legacy_path, current_path in server.LEGACY_PATHS.items():
            self.assertEqual(
                server.resolve_request_path(f"{legacy_path}?cache=1"),
                f"{current_path}?cache=1",
            )

    def test_legacy_entrypoints_are_served_over_http(self) -> None:
        module = load_server_module()
        handler = partial(module.NoCacheHandler, directory=str(EXPORTER_DIR))
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            port = httpd.server_address[1]
            paths = [*module.LEGACY_PATHS, "/callback?_miro=1&_sdk=stable"]
            for path in paths:
                with self.subTest(path=path):
                    with urlopen(
                        f"http://127.0.0.1:{port}{path}", timeout=2
                    ) as response:
                        body = response.read()
                        self.assertEqual(response.status, 200)
                        self.assertIn(
                            b"Exporter version: 20260727-complete-json", body
                        )
                        self.assertEqual(
                            response.headers["Cache-Control"],
                            "no-store, no-cache, must-revalidate, max-age=0",
                        )
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=2)

    def test_server_listens_on_both_localhost_families(self) -> None:
        server = load_server_module()

        specs = server.server_specs("localhost")
        self.assertEqual([host for host, _ in specs], ["127.0.0.1", "::1"])
        self.assertEqual(specs[0][1].address_family, socket.AF_INET)
        self.assertEqual(specs[1][1].address_family, socket.AF_INET6)

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
        self.assertIn('const EXPORTER_VERSION = "20260727-complete-json"', js)
        self.assertIn('const CAPTURE_PROFILE = "maximum_board_v1"', js)
        self.assertIn("exporter_version: EXPORTER_VERSION", js)
        self.assertIn("capture_profile: CAPTURE_PROFILE", js)
        self.assertIn('method: "miro.board.get"', js)
        self.assertIn('scope: "api_exposed_board_items"', js)
        self.assertIn("capture_complete: captureComplete", js)
        self.assertIn("board_complete: false", js)
        self.assertIn('coverage_basis: "miro.board.get_api_surface"', js)
        self.assertIn('"unsupported_item_details_unavailable"', js)
        self.assertIn('"unsupported_parent_children_not_enumerated"', js)
        self.assertIn('"comment_content_unavailable"', js)
        self.assertIn("serialization_errors: serializationErrors", js)
        self.assertIn("complete: itemsComplete", js)
        self.assertIn("function toPlain", js)
        self.assertIn(
            'const SERIALIZATION_MARKER = "__miro_export_serialization__"', js
        )
        self.assertIn('"non_finite_number"', js)
        self.assertIn('"bigint"', js)
        self.assertIn('"circular_reference"', js)
        self.assertIn("JSON_PRESERVING_MARKER_KINDS", js)
        self.assertIn('"undefined"', js)
        self.assertIn('"non_finite_number"', js)
        self.assertIn("allSerializationErrors.length === 0", js)
        self.assertIn("TABLE_DIAGNOSTIC_TYPES", js)
        self.assertIn("function deepInspectTableLikeItem", js)
        self.assertIn("Object.getOwnPropertyNames", js)
        self.assertIn("known_field_reads", js)
        self.assertIn("prototype_chain", js)
        self.assertIn("diagnostics: buildDiagnostics(items)", js)
        self.assertIn("diagnostics: buildDiagnostics(selection)", js)
        self.assertIn("const itemSerializationIssues = [];", js)
        self.assertIn("selection: plainSelection", js)
        self.assertNotIn("uniquePlainItems", js)

    def test_index_registers_miro_toolbar_icon(self) -> None:
        html = (EXPORTER_DIR / "index.html").read_text(encoding="utf-8")

        self.assertIn("https://miro.com/app/static/sdk/v2/miro.js", html)
        self.assertIn('miro.board.ui.on("icon:click"', html)
        self.assertIn("miro.board.ui.openPanel", html)
        self.assertIn("panel.html", html)
        self.assertIn("Exporter version: 20260727-complete-json", html)

    def test_panel_loads_miro_sdk_and_local_exporter(self) -> None:
        html = (EXPORTER_DIR / "panel.html").read_text(encoding="utf-8")

        self.assertIn("https://miro.com/app/static/sdk/v2/miro.js", html)
        self.assertIn("./exporter.js", html)
        self.assertIn("create-generated-probe", html)
        self.assertIn("export-board", html)
        self.assertIn("export-selection", html)
        self.assertIn("./exporter.js?v=20260727-complete-json", html)
        self.assertIn("Exporter version: 20260727-complete-json", html)

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
        self.assertIn(
            "sdkUri: http://localhost:8766/index.html", manifest
        )
        self.assertIn("Use this URI for SDK authorization", manifest)
        self.assertIn("boards:read", manifest)
        self.assertIn("boards:write", manifest)

    def test_readme_warns_about_team_and_duplicate_apps(self) -> None:
        readme = (EXPORTER_DIR / "README.md").read_text(encoding="utf-8")

        self.assertIn("same team as the target board", readme)
        self.assertIn("If several", readme)
        self.assertIn("Profile settings", readme)
        self.assertIn("http://localhost:8766/index.html", readme)
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
