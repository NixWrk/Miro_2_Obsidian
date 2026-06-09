from __future__ import annotations

import sys
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"

sys.path.insert(0, str(SCRIPTS_DIR))

from miro_rest_probe_board import build_manifest, planned_requests, resolve_placeholders  # noqa: E402


class MiroRestProbeBoardTests(unittest.TestCase):
    def test_manifest_includes_rest_creatable_item_families(self) -> None:
        manifest = build_manifest()

        item_types = {operation["item_type"] for operation in manifest["operations"]}

        self.assertEqual(
            item_types,
            {"frame", "text", "shape", "sticky_note", "card", "app_card", "connector"},
        )

    def test_connector_uses_placeholders_for_created_item_ids(self) -> None:
        manifest = build_manifest()
        connector = next(operation for operation in manifest["operations"] if operation["item_type"] == "connector")

        self.assertEqual(connector["depends_on"], ("shape_round_rect", "sticky_note"))
        self.assertEqual(connector["payload"]["startItem"]["id"], "$shape_round_rect.id")
        self.assertEqual(connector["payload"]["endItem"]["id"], "$sticky_note.id")

    def test_resolves_nested_placeholders(self) -> None:
        payload = {"startItem": {"id": "$shape_round_rect.id"}, "labels": ["$sticky_note.id"]}
        results = {"shape_round_rect": {"id": "shape-1"}, "sticky_note": {"id": "sticky-1"}}

        resolved = resolve_placeholders(payload, results)

        self.assertEqual(resolved["startItem"]["id"], "shape-1")
        self.assertEqual(resolved["labels"], ["sticky-1"])

    def test_planned_requests_expand_board_id_and_base_url(self) -> None:
        manifest = build_manifest()

        requests = planned_requests(manifest, "board-1", base_url="https://example.invalid/v2")

        self.assertTrue(requests[0]["url"].startswith("https://example.invalid/v2/boards/board-1/"))
        self.assertEqual(requests[0]["method"], "POST")


if __name__ == "__main__":
    unittest.main()
