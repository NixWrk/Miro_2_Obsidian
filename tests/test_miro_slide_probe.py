from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"

sys.path.insert(0, str(SCRIPTS_DIR))

from miro_slide_probe import (  # noqa: E402
    build_detail_probe_requests,
    build_slide_probe_requests,
    classify_status,
    decide_probe_result,
    extract_slide_items,
    extract_slide_items_from_value,
    find_textish_values,
    item_has_geometry,
    main,
    run_slide_probe,
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


class MiroSlideProbeTests(unittest.TestCase):
    def test_build_requests_checks_public_and_experimental_paths(self) -> None:
        requests = build_slide_probe_requests(
            "board-1",
            base_url="https://example.invalid/v2",
            experimental_base_url="https://example.invalid/v2-experimental",
        )

        self.assertEqual([request["key"] for request in requests], [
            "public_items_type_slide_container",
            "public_items_type_frame",
            "experimental_slides_collection",
            "experimental_slide_containers_collection",
            "experimental_presentations_collection",
        ])
        self.assertEqual(requests[0]["params"]["type"], "slide_container")
        self.assertEqual(requests[1]["params"]["type"], "frame")
        self.assertTrue(requests[2]["url"].endswith("/v2-experimental/boards/board-1/slides"))

    def test_build_detail_requests_for_discovered_slide_items(self) -> None:
        requests = build_detail_probe_requests(
            "board-1",
            [{"id": "deck-1", "type": "slide_container"}, {"id": "frame-1", "type": "frame"}],
            base_url="https://example.invalid/v2",
            experimental_base_url="https://example.invalid/v2-experimental",
        )

        keys = [request["key"] for request in requests]
        self.assertIn("public_item_detail_slide_container_deck-1", keys)
        self.assertIn("experimental_slide_container_detail_deck-1", keys)
        self.assertIn("experimental_slides_for_container_deck-1", keys)
        self.assertIn("public_item_detail_frame_frame-1", keys)

    def test_classifies_status_codes(self) -> None:
        self.assertEqual(classify_status(200), "available")
        self.assertEqual(classify_status(400), "unsupported_or_bad_request")
        self.assertEqual(classify_status(403), "auth_or_scope_blocked")
        self.assertEqual(classify_status(404), "not_found_or_endpoint_absent")
        self.assertEqual(classify_status(429), "rate_limited")
        self.assertEqual(classify_status(503), "server_error")

    def test_extracts_slide_container_frame_and_descendant_from_evidence(self) -> None:
        items = extract_slide_items_from_value(
            {
                "items": [
                    {"id": "deck-1", "type": "slide_container"},
                    {
                        "id": "frame-1",
                        "type": "frame",
                        "parent": {"id": "deck-1"},
                        "position": {"x": 10, "y": 20},
                        "geometry": {"width": 640, "height": 360},
                    },
                    {"id": "text-1", "type": "text", "parent": {"id": "frame-1"}, "data": {"content": "Slide text"}},
                    {"id": "frame-ordinary", "type": "frame"},
                ]
            },
            source="rest-export.json",
        )

        self.assertEqual([(item["id"], item["slide_role"]) for item in items], [
            ("deck-1", "slide_container"),
            ("frame-1", "slide_frame"),
            ("text-1", "slide_descendant"),
        ])
        self.assertTrue(item_has_geometry(items[1]))

    def test_extracts_slide_items_from_available_responses(self) -> None:
        items = extract_slide_items(
            [
                {
                    "key": "public_items_type_slide_container",
                    "classification": "available",
                    "body": {
                        "data": [
                            {"id": "deck-1", "type": "slide_container"},
                            {"id": "frame-1", "type": "frame", "parent": {"id": "deck-1"}},
                        ]
                    },
                }
            ]
        )

        self.assertEqual([item["id"] for item in items], ["deck-1", "frame-1"])
        self.assertEqual(items[1]["slide_role"], "slide_frame")

    def test_detects_textish_values(self) -> None:
        values = find_textish_values({"slides": [{"title": "Sprint review"}]})

        self.assertEqual(values, [{"path": "slides[0].title", "value": "Sprint review"}])

    def test_decides_frames_available_only_when_deck_and_geometry_exist(self) -> None:
        self.assertEqual(
            decide_probe_result(
                slide_container_count=1,
                slide_frame_count=2,
                slide_frame_geometry_count=2,
                available_count=2,
                auth_blocked_keys=[],
            ),
            "slide_frames_with_geometry_available",
        )
        self.assertEqual(
            decide_probe_result(
                slide_container_count=1,
                slide_frame_count=0,
                slide_frame_geometry_count=0,
                available_count=2,
                auth_blocked_keys=[],
            ),
            "slide_container_without_recoverable_frames",
        )

    def test_probe_runs_detail_requests_and_omits_secret_from_payload(self) -> None:
        session = FakeSession([
            FakeResponse({"data": [{"id": "deck-1", "type": "slide_container"}]}, status_code=200),
            FakeResponse({"data": [{"id": "frame-1", "type": "frame", "parent": {"id": "deck-1"}, "position": {"x": 1, "y": 2}, "geometry": {"width": 10, "height": 10}}]}, status_code=200),
            FakeResponse({"message": "No endpoint"}, status_code=404),
            FakeResponse({"message": "No endpoint"}, status_code=404),
            FakeResponse({"message": "No endpoint"}, status_code=404),
            FakeResponse({"id": "deck-1", "type": "slide_container"}, status_code=200),
            FakeResponse({"id": "deck-1", "type": "slide_container"}, status_code=200),
            FakeResponse({"message": "No endpoint"}, status_code=404),
            FakeResponse({"message": "No endpoint"}, status_code=404),
            FakeResponse({"id": "frame-1", "type": "frame", "parent": {"id": "deck-1"}, "position": {"x": 1, "y": 2}, "geometry": {"width": 10, "height": 10}}, status_code=200),
            FakeResponse({"id": "frame-1", "type": "frame", "parent": {"id": "deck-1"}, "position": {"x": 1, "y": 2}, "geometry": {"width": 10, "height": 10}}, status_code=200),
        ])

        payload = run_slide_probe(board_id="board-1", token="secret-token", session=session)

        self.assertEqual(payload["summary"]["slide_containers"], 1)
        self.assertEqual(payload["summary"]["slide_frames"], 1)
        self.assertEqual(payload["summary"]["slide_frames_with_geometry"], 1)
        self.assertEqual(payload["decision"], "slide_frames_with_geometry_available")
        self.assertNotIn("secret-token", str(payload))
        self.assertEqual(session.calls[0]["headers"]["Authorization"], "Bearer secret-token")

    def test_probe_uses_evidence_json_to_seed_detail_requests(self) -> None:
        session = FakeSession([
            FakeResponse({"data": []}, status_code=400),
            FakeResponse({"data": []}, status_code=200),
            FakeResponse({"message": "No endpoint"}, status_code=404),
            FakeResponse({"message": "No endpoint"}, status_code=404),
            FakeResponse({"message": "No endpoint"}, status_code=404),
            FakeResponse({"id": "deck-1", "type": "slide_container"}, status_code=200),
            FakeResponse({"id": "deck-1", "type": "slide_container"}, status_code=200),
            FakeResponse({"message": "No endpoint"}, status_code=404),
            FakeResponse({"message": "No endpoint"}, status_code=404),
            FakeResponse({"id": "frame-1", "type": "frame", "parent": {"id": "deck-1"}, "position": {"x": 1, "y": 2}, "geometry": {"width": 10, "height": 10}}, status_code=200),
            FakeResponse({"id": "frame-1", "type": "frame", "parent": {"id": "deck-1"}, "position": {"x": 1, "y": 2}, "geometry": {"width": 10, "height": 10}}, status_code=200),
        ])

        payload = run_slide_probe(
            board_id="board-1",
            token="secret-token",
            session=session,
            evidence_roots=[
                {
                    "items": [
                        {"id": "deck-1", "type": "slide_container"},
                        {"id": "frame-1", "type": "frame", "parent": {"id": "deck-1"}, "position": {"x": 1, "y": 2}, "geometry": {"width": 10, "height": 10}},
                    ]
                }
            ],
            evidence_sources=["rest-export.json"],
        )

        self.assertEqual(payload["summary"]["evidence_slide_items"], 2)
        self.assertEqual(payload["summary"]["slide_containers"], 1)
        self.assertEqual(payload["summary"]["slide_frames"], 1)

    def test_cli_writes_probe_output_without_printing_token(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "slide_probe.json"
            with patch("miro_slide_probe.resolve_token_from_args", return_value="secret-token"):
                with patch(
                    "miro_slide_probe.run_slide_probe",
                    return_value={
                        "kind": "miro_slide_source_probe",
                        "summary": {
                            "checked": 5,
                            "available": 0,
                            "slide_containers": 0,
                            "slide_frames": 0,
                            "slide_frames_with_geometry": 0,
                            "slide_descendants": 0,
                        },
                        "decision": "slide_source_not_found",
                        "requests": [],
                        "evidence_sources": [],
                        "slide_items": [],
                        "contentful_slide_items": [],
                    },
                ):
                    with patch.object(sys, "argv", ["miro_slide_probe.py", "--board-id", "board-1", "--output", str(output)]):
                        self.assertEqual(main(), 0)

            text = output.read_text(encoding="utf-8")
            self.assertIn("miro_slide_source_probe", text)
            self.assertNotIn("secret-token", text)


if __name__ == "__main__":
    unittest.main()
