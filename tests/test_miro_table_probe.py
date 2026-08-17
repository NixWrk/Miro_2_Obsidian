from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"

from scripts.miro_table_probe import (  # noqa: E402
    build_detail_probe_requests,
    build_table_probe_requests,
    classify_status,
    decide_probe_result,
    extract_table_items,
    extract_table_items_from_value,
    find_textish_values,
    main,
    run_table_probe,
    table_items_with_text,
)


class FakeResponse:
    def __init__(self, payload: object, *, status_code: int = 200) -> None:
        self.payload = payload
        self.status_code = status_code
        self.text = str(payload)

    def json(self) -> object:
        return self.payload


class FakeSession:
    def __init__(self, responses: list[FakeResponse]) -> None:
        self.responses = responses
        self.calls: list[dict] = []
        self.headers: dict[str, str] = {}

    def get(self, url: str, *, params: dict, headers: dict, timeout: int) -> FakeResponse:
        self.calls.append({"url": url, "params": params, "headers": headers, "timeout": timeout})
        return self.responses.pop(0)


class MiroTableProbeTests(unittest.TestCase):
    def test_build_requests_checks_public_and_experimental_paths(self) -> None:
        requests = build_table_probe_requests(
            "board-1",
            base_url="https://example.invalid/v2",
            experimental_base_url="https://example.invalid/v2-experimental",
        )

        self.assertEqual([request["key"] for request in requests], [
            "public_items_type_table",
            "public_items_type_table_text",
            "public_data_table_formats_collection",
            "experimental_tables_collection",
            "experimental_data_table_formats_collection",
        ])
        self.assertEqual(requests[0]["params"]["type"], "table")
        self.assertEqual(requests[1]["params"]["type"], "table_text")
        self.assertTrue(requests[3]["url"].endswith("/v2-experimental/boards/board-1/tables"))

    def test_build_detail_requests_for_discovered_table_items(self) -> None:
        requests = build_detail_probe_requests(
            "board-1",
            [{"id": "table-1", "type": "table"}, {"id": "cell-1", "type": "table_text"}],
            base_url="https://example.invalid/v2",
            experimental_base_url="https://example.invalid/v2-experimental",
        )

        keys = [request["key"] for request in requests]
        self.assertIn("public_item_detail_table_table-1", keys)
        self.assertIn("experimental_table_detail_table-1", keys)
        self.assertIn("public_item_detail_table_text_cell-1", keys)

    def test_classifies_status_codes(self) -> None:
        self.assertEqual(classify_status(200), "available")
        self.assertEqual(classify_status(400), "unsupported_or_bad_request")
        self.assertEqual(classify_status(403), "auth_or_scope_blocked")
        self.assertEqual(classify_status(404), "not_found_or_endpoint_absent")
        self.assertEqual(classify_status(429), "rate_limited")
        self.assertEqual(classify_status(503), "server_error")

    def test_extracts_table_items_from_available_responses(self) -> None:
        items = extract_table_items(
            [
                {
                    "key": "public_items_type_table",
                    "classification": "available",
                    "body": {"data": [{"id": "table-1", "type": "table"}]},
                },
                {
                    "key": "public_item_detail_table_text_cell-1",
                    "classification": "available",
                    "body": {"id": "cell-1", "type": "table_text"},
                },
            ]
        )

        self.assertEqual([item["id"] for item in items], ["table-1", "cell-1"])
        self.assertEqual(items[0]["source"], "public_items_type_table")

    def test_extracts_table_items_from_evidence_json(self) -> None:
        items = extract_table_items_from_value(
            {"items": [{"id": "text-1", "type": "text"}, {"id": "cell-1", "type": "table_text"}]},
            source="rest-export.json",
        )

        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["id"], "cell-1")
        self.assertEqual(items[0]["source"], "rest-export.json")

    def test_detects_textish_table_values(self) -> None:
        values = find_textish_values({"rows": [{"cells": [{"text": "Revenue"}]}]})

        self.assertEqual(values, [{"path": "rows[0].cells[0].text", "value": "Revenue"}])
        self.assertEqual(table_items_with_text([{"id": "table-1", "type": "table", "rows": [{"cells": [{"text": "Revenue"}]}]}])[0]["id"], "table-1")

    def test_decides_geometry_without_content_and_blocked_candidate(self) -> None:
        self.assertEqual(
            decide_probe_result(
                table_item_count=2,
                contentful_table_item_count=0,
                auth_blocked_keys=["experimental_tables_collection"],
                available_count=2,
            ),
            "table_geometry_without_content_and_blocked_candidate",
        )
        self.assertEqual(
            decide_probe_result(
                table_item_count=1,
                contentful_table_item_count=1,
                auth_blocked_keys=[],
                available_count=1,
            ),
            "table_content_available",
        )

    def test_probe_runs_detail_requests_and_omits_secret_from_payload(self) -> None:
        session = FakeSession([
            FakeResponse({"data": [{"id": "table-1", "type": "table"}]}, status_code=200),
            FakeResponse({"data": [{"id": "cell-1", "type": "table_text"}]}, status_code=200),
            FakeResponse({"data": []}, status_code=200),
            FakeResponse({"message": "Access Denied"}, status_code=403),
            FakeResponse({"message": "No endpoint"}, status_code=404),
            FakeResponse({"id": "table-1", "type": "table"}, status_code=200),
            FakeResponse({"id": "table-1", "type": "table"}, status_code=200),
            FakeResponse({"message": "Access Denied"}, status_code=403),
            FakeResponse({"message": "Widget not found"}, status_code=404),
            FakeResponse({"id": "cell-1", "type": "table_text"}, status_code=200),
            FakeResponse({"id": "cell-1", "type": "table_text"}, status_code=200),
        ])

        payload = run_table_probe(board_id="board-1", token="secret-token", session=session)

        self.assertEqual(payload["summary"]["table_items"], 2)
        self.assertEqual(payload["summary"]["contentful_table_items"], 0)
        self.assertEqual(payload["decision"], "table_geometry_without_content_and_blocked_candidate")
        self.assertNotIn("secret-token", str(payload))
        self.assertEqual(session.calls[0]["headers"]["Authorization"], "Bearer secret-token")

    def test_probe_uses_evidence_json_to_seed_detail_requests(self) -> None:
        session = FakeSession([
            FakeResponse({"data": []}, status_code=400),
            FakeResponse({"data": []}, status_code=400),
            FakeResponse({"data": []}, status_code=200),
            FakeResponse({"message": "Access Denied"}, status_code=403),
            FakeResponse({"message": "No endpoint"}, status_code=404),
            FakeResponse({"id": "table-1", "type": "table"}, status_code=200),
            FakeResponse({"id": "table-1", "type": "table"}, status_code=200),
            FakeResponse({"message": "Access Denied"}, status_code=403),
            FakeResponse({"message": "Widget not found"}, status_code=404),
        ])

        payload = run_table_probe(
            board_id="board-1",
            token="secret-token",
            session=session,
            evidence_roots=[[{"id": "table-1", "type": "table", "geometry": {"width": 100, "height": 80}}]],
            evidence_sources=["rest-export.json"],
        )

        self.assertEqual(payload["summary"]["evidence_table_items"], 1)
        self.assertEqual(payload["summary"]["table_items"], 1)
        self.assertEqual(payload["table_items"][0]["source"], "public_item_detail_table_table-1")

    def test_cli_writes_probe_output_without_printing_token(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "table_probe.json"
            with patch("scripts.miro_table_probe.resolve_token_from_args", return_value="secret-token"):
                with patch(
                    "scripts.miro_table_probe.run_table_probe",
                    return_value={
                        "kind": "miro_table_source_probe",
                        "summary": {
                            "checked": 5,
                            "available": 0,
                            "table_items": 0,
                            "contentful_table_items": 0,
                            "evidence_table_items": 0,
                        },
                        "decision": "table_source_not_found",
                        "requests": [],
                        "evidence_sources": [],
                        "table_items": [],
                        "contentful_table_items": [],
                    },
                ):
                    with patch.object(sys, "argv", ["scripts.miro_table_probe.py", "--board-id", "board-1", "--output", str(output)]):
                        self.assertEqual(main(), 0)

            text = output.read_text(encoding="utf-8")
            self.assertIn("miro_table_source_probe", text)
            self.assertNotIn("secret-token", text)


if __name__ == "__main__":
    unittest.main()
