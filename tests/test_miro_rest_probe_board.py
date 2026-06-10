from __future__ import annotations

import sys
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"

sys.path.insert(0, str(SCRIPTS_DIR))

from miro_rest_probe_board import build_manifest, execute_manifest, planned_requests, resolve_placeholders  # noqa: E402


class FakeResponse:
    def __init__(self, payload: dict, *, ok: bool = True, status_code: int = 200) -> None:
        self.payload = payload
        self.ok = ok
        self.status_code = status_code
        self.text = str(payload)

    def json(self) -> dict:
        return self.payload


class FakeSession:
    def __init__(self, responses: list[FakeResponse]) -> None:
        self.responses = responses
        self.calls: list[dict] = []

    def post(self, url: str, *, headers: dict, json: dict, timeout: int) -> FakeResponse:
        self.calls.append({"url": url, "headers": headers, "json": json, "timeout": timeout})
        return self.responses.pop(0)


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

    def test_sticky_note_payload_uses_width_only_geometry(self) -> None:
        manifest = build_manifest()
        sticky = next(operation for operation in manifest["operations"] if operation["item_type"] == "sticky_note")

        self.assertEqual(sticky["payload"]["geometry"], {"width": 220})

    def test_app_card_probe_fields_use_exported_label_schema(self) -> None:
        manifest = build_manifest()
        app_card = next(operation for operation in manifest["operations"] if operation["item_type"] == "app_card")

        self.assertEqual(app_card["payload"]["data"]["fields"][0], {"label": "Status", "value": "Probe"})

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

    def test_execute_manifest_returns_partial_result_on_item_failure(self) -> None:
        manifest = {
            "board": {"name": "probe"},
            "operations": [
                {
                    "key": "text_ok",
                    "item_type": "text",
                    "method": "POST",
                    "path": "/boards/{board_id}/texts",
                    "payload": {"data": {"content": "ok"}},
                },
                {
                    "key": "sticky_bad",
                    "item_type": "sticky_note",
                    "method": "POST",
                    "path": "/boards/{board_id}/sticky_notes",
                    "payload": {"data": {"content": "bad"}},
                },
            ],
        }
        session = FakeSession(
            [
                FakeResponse({"id": "board-1"}),
                FakeResponse({"id": "text-1"}),
                FakeResponse({"message": "bad request"}, ok=False, status_code=400),
            ]
        )

        result = execute_manifest(manifest, "token-1", session=session)

        self.assertFalse(result["ok"])
        self.assertEqual(result["board_id"], "board-1")
        self.assertEqual(result["items"]["text_ok"]["id"], "text-1")
        self.assertEqual(result["failed_request"]["key"], "sticky_bad")
        self.assertEqual(result["failed_request"]["status_code"], 400)


if __name__ == "__main__":
    unittest.main()
